"use strict";
// arena.js — play the root ("new") engine against the frozen baseline/ ("old")
// engine for many games, in both forced-jump modes.
//
// PURPOSE: primarily regression prevention, secondarily strength measurement.
// A run raises an ALARM (non-zero exit) on any of:
//   - rules divergence between versions (shadow replay mismatch),
//   - a player returning an illegal move,
//   - a player throwing (contained: it forfeits that game, the match goes on),
//   - self-play asymmetry (identical configs must tie a paired match exactly).
// The score/Elo lines below the regression line are the strength measurement.
//
// Design notes:
// - The two versions are loaded as independent Node modules (root vs
//   baseline/), so their module-level state (jumpsAreForced, seeded RNGs)
//   never interacts. The chosen forced-jump mode is set on every loaded copy.
// - One engine acts as REFEREE and owns the authoritative game. Each player
//   rebuilds the position inside its OWN engine version from the referee's
//   getState() JSON, searches there, and returns a plain {from, to} move,
//   which the referee applies with the checked makeMove. A move the referee
//   rejects loses the game for that player ("illegal-move"). This keeps the
//   match meaningful even if a fix changes the rules: the referee's rules
//   govern, and rule disagreements are surfaced rather than hidden.
// - Divergence detection: unless disabled, a shadow game in the OTHER engine
//   version replays every move; any rejection, board mismatch, or legal-move-
//   set mismatch is recorded per ply. With rules-identical versions this must
//   stay at zero — it is the regression alarm for rules-affecting fixes.
// - Fairness: games are played in pairs sharing one seeded random opening,
//   with colors swapped. Players are constructed fresh per game, so a
//   self-play match (identical versions) mirrors exactly and scores 50%.
// - Draws: the engine itself never declares a draw (BUGS.md #6), so the arena
//   adjudicates: no capture/pawn-advance for --draw-plies plies, or --max-plies
//   total, is a draw.
//
// Usage:
//   node arena.js                          # new vs baseline, both modes
//   node arena.js --games 200 --depth 5
//   node arena.js --a new --b new          # self-play regression check
//   node arena.js --forced on --verbose
//   node arena.js --opts useTranspositionTable=true       # exercise TT path
//   node arena.js --opts useIterativeDeepening=true       # exercise ID+killer
//   node arena.js --opts-a doQuiesce=false                # asymmetric feature
//
// Options (defaults in brackets):
//   --games N            games per forced mode, rounded up to even [100]
//   --a, --b WHICH       'new' (root), 'baseline', or a snapshot directory
//                        containing common/checkers/players.js, e.g.
//                        'snapshots/after-tt-fix' [a=new, b=baseline]
//   --depth N            search depth for both sides [4]
//   --depth-a/-b N       per-side override
//   --random-a/-b        use the random player instead of search
//   --opts K=V,K=V       Search feature flags applied to BOTH sides; any
//                        public Search field works: useTranspositionTable,
//                        useIterativeDeepening, useKillerMove, doQuiesce,
//                        doAlphaBeta, evalDither, ... (values are coerced:
//                        true/false/numbers)
//   --opts-a/-b K=V,...  per-side feature flags (merged over --opts)
//   --max-seconds N      Search time budget, both sides (implies iterative
//                        deepening; makes results time-dependent, so the
//                        self-play symmetry alarm is skipped)
//   --max-seconds-a/-b N per-side time budget
//   --forced MODE        'both', 'on', or 'off' [both]
//   --seed N             opening-generator seed [1]
//   --opening-plies N    random opening plies shared by each game pair [6]
//   --draw-plies N       plies without progress adjudicated as a draw [50]
//   --max-plies N        hard game-length cap, adjudicated as a draw [300]
//   --referee WHICH      whose rules govern (same values as --a/--b) [new]
//   --no-tablebase       play without endgame tablebases (both search players
//                        share the mode-matching tablebase by default)
//   --no-verify          skip shadow-replay divergence detection
//   --verbose            per-game result lines

var path = require('path');
var fs = require('fs');

var BLACK = 1;
var RED = 2;

var engineCache = {};
// which: 'new' (root files), 'baseline' (baseline/), or any directory path
// (relative to the repo root) containing common.js/checkers.js/players.js —
// e.g. 'snapshots/after-tt-fix'.
function loadEngine(which) {
    if (!engineCache[which]) {
        var dir = which === 'new' ? __dirname :
            which === 'baseline' ? path.join(__dirname, 'baseline') :
            path.resolve(__dirname, which);
        ['common.js', 'checkers.js', 'players.js'].forEach(function (f) {
            if (!fs.existsSync(path.join(dir, f))) {
                throw new Error("engine '" + which + "': missing " + path.join(dir, f));
            }
        });
        engineCache[which] = {
            name: which,
            common: require(path.join(dir, 'common.js')),
            checkers: require(path.join(dir, 'checkers.js')),
            players: require(path.join(dir, 'players.js'))
        };
    }
    return engineCache[which];
}

function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// Endgame tablebases, loaded once per mode and shared by both players (the
// reader object is duck-typed: every engine version's Search consumes
// .tablebase via getEntry). Missing files degrade to tablebase-free play
// with a warning.
var tablebaseCache = {};
function loadArenaTablebase(forced) {
    var key = forced ? 'forced' : 'unforced';
    if (!(key in tablebaseCache)) {
        var file = path.join(__dirname, forced ? 'end8Forced' : 'end8Unforced');
        try {
            var raw = fs.readFileSync(file);
            var ResultList2 = loadEngine('new').checkers.ResultList2;
            tablebaseCache[key] = new ResultList2(
                raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
        } catch (e) {
            console.error("tablebase " + file + " unavailable (" + e.message + "); playing without it");
            tablebaseCache[key] = null;
        }
    }
    return tablebaseCache[key];
}

function moveKeySet(game) {
    return game.getMoves().map(function (m) { return m.from + '>' + m.to; }).sort().join(',');
}

// spec: {engine: 'new'|'baseline', type: 'search'|'random', depth, seed,
//        maxSeconds, searchOptions: {anyPublicSearchField: value}}
function makePlayer(spec, tablebase) {
    var engine = loadEngine(spec.engine);
    var label = spec.engine + (spec.type === 'random' ? ':random' : ':d' + spec.depth);
    var inner;
    if (spec.type === 'random') {
        inner = new engine.players.Random(spec.seed || 1);
    } else {
        inner = new engine.players.Search(spec.depth, spec.maxSeconds);
        // Always explicit: the shared instance when on, null when off —
        // never the engine's Node auto-load, which would defeat
        // --no-tablebase and double-load the files.
        inner.tablebase = tablebase || null;
        var optKeys = Object.keys(spec.searchOptions || {});
        optKeys.forEach(function (key) {
            if (!(key in inner)) {
                throw new Error("unknown Search option: " + key);
            }
            inner[key] = spec.searchOptions[key];
        });
        if (optKeys.length || spec.maxSeconds) {
            label += '[' + optKeys.map(function (k) { return k + '=' + spec.searchOptions[k]; })
                .concat(spec.maxSeconds ? ['maxSeconds=' + spec.maxSeconds] : [])
                .join(',') + ']';
        }
    }
    return {
        label: label,
        engine: engine,
        inner: inner,
        genMove: function (state) {
            var game = new engine.checkers.Game(deepCopy(state));
            return inner.genMove(game);
        }
    };
}

// Generate `plies` random opening moves (as plain {from,to}) that leave a
// live position, using the referee's rules.
function genOpening(referee, rand, plies) {
    for (;;) {
        var game = new referee.checkers.Game();
        var moves = [];
        var ok = true;
        for (var i = 0; i < plies; i++) {
            var legal = game.getMoves();
            if (legal.length === 0) { ok = false; break; }
            var m = legal[rand.int(legal.length)];
            moves.push({ from: m.from, to: m.to });
            game.makeMove(m, true);
        }
        if (ok && game.getMoves().length > 0) {
            return moves;
        }
    }
}

// players: {1: player, 2: player} by color. Returns
// {winner: 1|2|0, reason, plies, divergences: [{ply, kind, ...}]}
function playGame(referee, players, opening, opts) {
    var game = new referee.checkers.Game();
    var shadow = opts.shadowEngine ? new opts.shadowEngine.checkers.Game() : null;
    var divergences = [];

    function applyShadow(move, ply) {
        if (!shadow || divergences.length) return; // stop after first divergence
        var ok = shadow.makeMove(new opts.shadowEngine.checkers.Move(move.from, move.to));
        if (!ok) {
            divergences.push({ ply: ply, kind: 'shadow-rejected-move', move: move });
            return;
        }
        if (shadow.toCompactString() !== game.toCompactString() ||
            shadow.getJumpContinuationLoc() !== game.getJumpContinuationLoc()) {
            divergences.push({ ply: ply, kind: 'state-mismatch' });
            return;
        }
        var refereeMoves = moveKeySet(game);
        var shadowMoves = moveKeySet(shadow);
        if (refereeMoves !== shadowMoves) {
            divergences.push({ ply: ply, kind: 'legal-move-set-mismatch',
                referee: refereeMoves, shadow: shadowMoves });
        }
    }

    var ply = 0;
    opening.forEach(function (om) {
        if (!game.makeMove(new referee.checkers.Move(om.from, om.to))) {
            throw new Error("opening move rejected by referee: " + om.from + ">" + om.to);
        }
        applyShadow(om, ply);
        ply++;
    });

    for (;;) {
        if (game.getMoves().length === 0) {
            var loser = game.turnIsBlack() ? BLACK : RED;
            return { winner: 3 - loser, reason: 'no-moves', plies: ply, divergences: divergences };
        }
        if (game.getMovesSinceProgress() >= opts.drawPlies) {
            return { winner: 0, reason: 'draw-no-progress', plies: ply, divergences: divergences };
        }
        if (ply >= opts.maxPlies) {
            return { winner: 0, reason: 'draw-max-plies', plies: ply, divergences: divergences };
        }
        var color = game.turnIsBlack() ? BLACK : RED;
        var move;
        try {
            move = players[color].genMove(game.getState());
        } catch (e) {
            // A crashing player forfeits the game; the match continues and
            // the error is surfaced as a regression alarm.
            return { winner: 3 - color, reason: 'player-error', plies: ply, divergences: divergences,
                playerError: { by: players[color].label, error: String(e && e.message || e) } };
        }
        if (!move) {
            return { winner: 3 - color, reason: 'no-move-returned', plies: ply, divergences: divergences };
        }
        if (!game.makeMove(new referee.checkers.Move(move.from, move.to))) {
            return { winner: 3 - color, reason: 'illegal-move', plies: ply,
                divergences: divergences, illegalMove: { by: players[color].label, move: move } };
        }
        applyShadow(move, ply);
        ply++;
    }
}

function eloDiff(score) {
    if (score <= 0) return -Infinity;
    if (score >= 1) return Infinity;
    return 400 * Math.log10(score / (1 - score));
}

// Play one forced-jump mode. Returns a stats object.
function playMode(forced, opts) {
    var referee = loadEngine(opts.referee);
    // The chosen mode must be set on every loaded engine copy.
    var involved = {};
    [opts.referee, opts.a.engine, opts.b.engine].forEach(function (w) { involved[w] = true; });
    Object.keys(involved).forEach(function (w) {
        loadEngine(w).checkers.setForcedJumps(forced);
    });
    // Shadow-verify with whichever participating version is not refereeing.
    var shadowName = opts.a.engine !== opts.referee ? opts.a.engine :
        opts.b.engine !== opts.referee ? opts.b.engine : null;
    var shadowEngine = null;
    if (opts.verify && shadowName) {
        loadEngine(shadowName).checkers.setForcedJumps(forced);
        shadowEngine = loadEngine(shadowName);
    }

    var tablebase = opts.tablebase ? loadArenaTablebase(forced) : null;
    var rand = new referee.common.Random(opts.seed + (forced ? 0 : 1000000));
    var stats = {
        forced: forced, games: 0, aWins: 0, bWins: 0, draws: 0,
        aWinsAsBlack: 0, aWinsAsRed: 0, bWinsAsBlack: 0, bWinsAsRed: 0,
        reasons: {}, divergences: [], illegalMoves: [], playerErrors: [], totalPlies: 0
    };
    var pairs = Math.ceil(opts.games / 2);
    for (var p = 0; p < pairs; p++) {
        var opening = genOpening(referee, rand, opts.openingPlies);
        for (var g = 0; g < 2; g++) {
            var aIsBlack = (g === 0);
            // Fresh players each game so paired games are exact mirrors when
            // the versions are identical.
            var players = {};
            players[BLACK] = makePlayer(aIsBlack ? opts.a : opts.b, tablebase);
            players[RED] = makePlayer(aIsBlack ? opts.b : opts.a, tablebase);
            var result = playGame(referee, players, opening, {
                drawPlies: opts.drawPlies, maxPlies: opts.maxPlies, shadowEngine: shadowEngine
            });
            stats.games++;
            stats.totalPlies += result.plies;
            stats.reasons[result.reason] = (stats.reasons[result.reason] || 0) + 1;
            result.divergences.forEach(function (d) {
                d.game = stats.games;
                stats.divergences.push(d);
            });
            if (result.illegalMove) {
                result.illegalMove.game = stats.games;
                stats.illegalMoves.push(result.illegalMove);
            }
            if (result.playerError) {
                result.playerError.game = stats.games;
                stats.playerErrors.push(result.playerError);
            }
            var aWon = result.winner === (aIsBlack ? BLACK : RED);
            var bWon = result.winner === (aIsBlack ? RED : BLACK);
            if (aWon) {
                stats.aWins++;
                if (aIsBlack) stats.aWinsAsBlack++; else stats.aWinsAsRed++;
            } else if (bWon) {
                stats.bWins++;
                if (aIsBlack) stats.bWinsAsRed++; else stats.bWinsAsBlack++;
            } else {
                stats.draws++;
            }
            if (opts.verbose) {
                console.log("  game " + stats.games + ": " +
                    (result.winner === 0 ? "draw" : (aWon ? "A" : "B") + " wins") +
                    " (" + result.reason + ", " + result.plies + " plies," +
                    " A as " + (aIsBlack ? "black" : "red") + ")");
            }
        }
    }
    return stats;
}

function specLabel(spec) {
    return makePlayer(spec).label;
}

function summarize(stats, opts) {
    var n = stats.games;
    var score = (stats.aWins + 0.5 * stats.draws) / n;
    var se = Math.sqrt(score * (1 - score) / n);
    var lines = [];
    lines.push("=== Forced jumps: " + stats.forced + " ===");
    lines.push("A=" + specLabel(opts.a) + "  B=" + specLabel(opts.b) +
        "  referee=" + opts.referee + "  games=" + n +
        "  tablebase=" + (opts.tablebase ? "on" : "off"));
    // Regression indicators come first: that is the arena's primary job.
    var alarmCount = stats.divergences.length + stats.illegalMoves.length + stats.playerErrors.length;
    lines.push("regression: divergences " + stats.divergences.length +
        (opts.verify ? "" : " (verify off)") +
        ", illegal-moves " + stats.illegalMoves.length +
        ", player-errors " + stats.playerErrors.length +
        (alarmCount ? "   <<< ALARM" : "   OK"));
    if (stats.divergences.length) lines.push("  first divergence: " + JSON.stringify(stats.divergences[0]));
    if (stats.illegalMoves.length) lines.push("  first illegal move: " + JSON.stringify(stats.illegalMoves[0]));
    if (stats.playerErrors.length) lines.push("  first player error: " + JSON.stringify(stats.playerErrors[0]));
    lines.push("A wins " + stats.aWins + " (black " + stats.aWinsAsBlack + ", red " + stats.aWinsAsRed + ")" +
        "  B wins " + stats.bWins + " (black " + stats.bWinsAsBlack + ", red " + stats.bWinsAsRed + ")" +
        "  draws " + stats.draws);
    lines.push("A score " + (100 * score).toFixed(1) + "% ± " + (196 * se).toFixed(1) +
        "%  (Elo " + (isFinite(eloDiff(score)) ? (eloDiff(score) >= 0 ? "+" : "") + eloDiff(score).toFixed(0) : "∞") +
        ")  avg length " + (stats.totalPlies / n).toFixed(1) + " plies");
    lines.push("end reasons: " + Object.keys(stats.reasons).map(function (r) {
        return r + " " + stats.reasons[r];
    }).join(", "));
    return lines.join("\n");
}

function playMatch(opts) {
    opts = normalizeOptions(opts);
    var results = [];
    opts.forcedModes.forEach(function (forced) {
        results.push(playMode(forced, opts));
    });
    // Leave every involved engine copy back at the default.
    [opts.referee, opts.a.engine, opts.b.engine].forEach(function (w) {
        loadEngine(w).checkers.setForcedJumps(true);
    });
    // Regression alarms across all modes.
    var alarms = [];
    var mirrorConfigs = JSON.stringify(opts.a) === JSON.stringify(opts.b) &&
        !opts.a.maxSeconds && !opts.b.maxSeconds; // time budgets are nondeterministic
    results.forEach(function (stats) {
        var mode = "forced=" + stats.forced + ": ";
        stats.divergences.forEach(function (d) { alarms.push(mode + "rules divergence " + JSON.stringify(d)); });
        stats.illegalMoves.forEach(function (m) { alarms.push(mode + "illegal move " + JSON.stringify(m)); });
        stats.playerErrors.forEach(function (e) { alarms.push(mode + "player error " + JSON.stringify(e)); });
        if (mirrorConfigs && (stats.aWins !== stats.bWins ||
                stats.aWinsAsBlack !== stats.bWinsAsBlack || stats.aWinsAsRed !== stats.bWinsAsRed)) {
            alarms.push(mode + "self-play asymmetry: identical configs scored A " +
                stats.aWins + " / B " + stats.bWins + " — determinism regression");
        }
    });
    return { options: opts, results: results, alarms: alarms };
}

function normalizeOptions(o) {
    o = o || {};
    var opts = {
        games: o.games || 100,
        a: o.a || { engine: 'new', type: 'search', depth: o.depth || 4 },
        b: o.b || { engine: 'baseline', type: 'search', depth: o.depth || 4 },
        forcedModes: o.forcedModes || [true, false],
        seed: o.seed == null ? 1 : o.seed,
        openingPlies: o.openingPlies == null ? 6 : o.openingPlies,
        drawPlies: o.drawPlies || 50,
        maxPlies: o.maxPlies || 300,
        referee: o.referee || 'new',
        verify: o.verify,
        verbose: !!o.verbose,
        tablebase: o.tablebase == null ? true : !!o.tablebase
    };
    if (opts.games % 2 === 1) opts.games++;
    if (opts.verify == null) {
        opts.verify = opts.a.engine !== opts.b.engine || opts.referee !== opts.a.engine;
    }
    // Fail fast on typo'd Search options rather than mid-match.
    makePlayer(opts.a);
    makePlayer(opts.b);
    return opts;
}

// "useTranspositionTable=true,evalDither=0" -> {useTranspositionTable: true, evalDither: 0}
function parseSearchOptions(str) {
    var options = {};
    if (!str) return options;
    str.split(',').forEach(function (pair) {
        var eq = pair.indexOf('=');
        if (eq < 1) throw new Error("bad option (expected key=value): " + pair);
        var key = pair.slice(0, eq).trim();
        var raw = pair.slice(eq + 1).trim();
        options[key] = raw === 'true' ? true :
            raw === 'false' ? false :
            raw !== '' && !isNaN(Number(raw)) ? Number(raw) : raw;
    });
    return options;
}

function mergeOptions(base, override) {
    var merged = {};
    Object.keys(base).forEach(function (k) { merged[k] = base[k]; });
    Object.keys(override).forEach(function (k) { merged[k] = override[k]; });
    return merged;
}

function parseArgs(argv) {
    var o = { a: {}, b: {} };
    var flags = {};
    for (var i = 0; i < argv.length; i++) {
        var arg = argv[i];
        if (arg.slice(0, 2) !== '--') throw new Error("unexpected argument: " + arg);
        var key = arg.slice(2);
        var boolFlags = ['random-a', 'random-b', 'no-verify', 'verbose', 'no-tablebase'];
        if (boolFlags.indexOf(key) >= 0) {
            flags[key] = true;
        } else {
            flags[key] = argv[++i];
            if (flags[key] == null) throw new Error("missing value for --" + key);
        }
    }
    var depth = parseInt(flags['depth'] || '4', 10);
    var sharedOptions = parseSearchOptions(flags['opts']);
    o.games = parseInt(flags['games'] || '100', 10);
    o.a = {
        engine: flags['a'] || 'new',
        type: flags['random-a'] ? 'random' : 'search',
        depth: parseInt(flags['depth-a'] || depth, 10),
        seed: 101,
        maxSeconds: flags['max-seconds-a'] != null ? parseFloat(flags['max-seconds-a']) :
            flags['max-seconds'] != null ? parseFloat(flags['max-seconds']) : undefined,
        searchOptions: mergeOptions(sharedOptions, parseSearchOptions(flags['opts-a']))
    };
    o.b = {
        engine: flags['b'] || 'baseline',
        type: flags['random-b'] ? 'random' : 'search',
        depth: parseInt(flags['depth-b'] || depth, 10),
        seed: 202,
        maxSeconds: flags['max-seconds-b'] != null ? parseFloat(flags['max-seconds-b']) :
            flags['max-seconds'] != null ? parseFloat(flags['max-seconds']) : undefined,
        searchOptions: mergeOptions(sharedOptions, parseSearchOptions(flags['opts-b']))
    };
    var forced = flags['forced'] || 'both';
    o.forcedModes = forced === 'both' ? [true, false] :
        forced === 'on' ? [true] :
        forced === 'off' ? [false] : (function () { throw new Error("--forced must be both|on|off"); })();
    if (flags['seed'] != null) o.seed = parseInt(flags['seed'], 10);
    if (flags['opening-plies'] != null) o.openingPlies = parseInt(flags['opening-plies'], 10);
    if (flags['draw-plies'] != null) o.drawPlies = parseInt(flags['draw-plies'], 10);
    if (flags['max-plies'] != null) o.maxPlies = parseInt(flags['max-plies'], 10);
    o.referee = flags['referee'] || 'new';
    if (flags['no-verify']) o.verify = false;
    if (flags['no-tablebase']) o.tablebase = false;
    o.verbose = !!flags['verbose'];
    return o;
}

if (require.main === module) {
    var opts;
    try {
        opts = parseArgs(process.argv.slice(2));
        makePlayer(opts.a); // clean fail-fast on typo'd Search options
        makePlayer(opts.b);
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
    var match = playMatch(opts);
    match.results.forEach(function (stats) {
        console.log(summarize(stats, match.options));
        console.log("");
    });
    if (match.alarms.length > 0) {
        console.log("REGRESSION ALARMS (" + match.alarms.length + "):");
        match.alarms.slice(0, 10).forEach(function (a) { console.log("  " + a); });
        if (match.alarms.length > 10) console.log("  ... and " + (match.alarms.length - 10) + " more");
        process.exitCode = 1;
    }
}

module.exports = {
    loadEngine: loadEngine,
    loadArenaTablebase: loadArenaTablebase,
    makePlayer: makePlayer,
    genOpening: genOpening,
    playGame: playGame,
    playMatch: playMatch,
    summarize: summarize,
    BLACK: BLACK,
    RED: RED
};
