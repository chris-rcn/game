"use strict";
// Endgame tablebase generator: solves all positions with up to `maxPieces`
// pieces by layered retrograde analysis, using the engine itself for move
// generation and transitions (rule fidelity is inherited, not reimplemented).
//
// Semantics (matching the engine and validated against the shipped tables —
// see tools/verify-generator.js):
// - A state is (board, side to move, jumpContinuationLoc). Mid-jump states
//   are solved (values flow through them) but not stored in v4 output.
// - The side to move with no legal moves has lost: v = -1, d = 0.
// - Values are side-to-move negamax: a move to a child keeps the mover's
//   perspective when the turn continues (multi-jump) and negates it when
//   the turn passes.
// - Wins take the fastest path (d = 1 + min losing-child d), losses the
//   slowest (d = 1 + max winning-child d). States never labeled after
//   convergence are draws under optimal play (clockless semantics).
//
// Scale: base states are identified by checkers.tablebaseRank (dense, no
// hashing); mid-jump states get appended ids via a Map. Edges live in flat
// typed arrays. The <=4-piece space (~19M slots + ~14M live states) fits
// comfortably in a few hundred MB.
//
// Usage: node tools/generate-tablebase.js <maxPieces> forced|unforced <out> [--v3]

var path = require('path');
var fs = require('fs');
var checkers = require(path.join(__dirname, '..', 'checkers.js'));

var BLACK = 1, RED = 2, PAWN = 3, KING = 4, OPEN = 8;

var darkSquares = [];
(function () {
    for (var r = 0; r < 8; r++) {
        for (var c = 0; c < 8; c++) {
            if ((r + c) % 2 === 1) darkSquares.push(r * 9 + c + 1);
        }
    }
})();

function rowOf(loc) { return Math.floor((loc - 1) / 9); }

function pieceStatesFor(loc) {
    var row = rowOf(loc);
    var states = [BLACK | KING, RED | KING];
    if (row !== 0) states.push(BLACK);
    if (row !== 7) states.push(RED);
    return states;
}

// One shared Game mutated through the engine's state backdoor: constructing
// a Game allocates dozens of closures, far too slow for millions of states.
var backdoor = {};
var sharedGame = new checkers.Game(undefined, backdoor);
var sharedSquares = [];
var sharedLists = [];
sharedLists[BLACK] = [];
sharedLists[RED] = [];
function loadShared(placements, turn, jumpLoc) {
    for (var i = 0; i < darkSquares.length; i++) sharedSquares[darkSquares[i]] = OPEN;
    sharedLists[BLACK].length = 0;
    sharedLists[RED].length = 0;
    for (i = 0; i < placements.length; i++) {
        var p = placements[i];
        sharedSquares[p[0]] = p[1];
        sharedLists[p[1] & PAWN].push(p[0]);
    }
    backdoor.setState({
        turn: turn, jumpContinuationLoc: jumpLoc || 0, squares: sharedSquares,
        movesSinceProgress: 0, legalMoves: null, checkers: sharedLists
    });
    return sharedGame;
}

// Standalone Game for callers that need an independent object.
function makeGame(placements, turn, jumpLoc) {
    var squares = [], lists = [];
    lists[BLACK] = [];
    lists[RED] = [];
    darkSquares.forEach(function (l) { squares[l] = OPEN; });
    placements.forEach(function (p) {
        squares[p[0]] = p[1];
        lists[p[1] & PAWN].push(p[0]);
    });
    return new checkers.Game({
        turn: turn, jumpContinuationLoc: jumpLoc || 0, squares: squares,
        movesSinceProgress: 0, legalMoves: null, checkers: lists
    });
}

function midjumpKeyOf(game) {
    return game.toCompactString() + "|" + game.getJumpContinuationLoc();
}

// Enumerate every state with 1..maxPieces pieces, both turns, including
// mid-jump continuation states and single-color elimination terminals
// (winner holds at most maxPieces-1 pieces). Each state is visited exactly
// once; the shared Game passed to onState is only valid during the callback.
function enumerateStates(maxPieces, onState) {
    var placements = [];
    function emit() {
        var colors = 0;
        for (var i = 0; i < placements.length; i++) colors |= (placements[i][1] & PAWN);
        if (colors !== PAWN) {
            if (placements.length <= maxPieces - 1) {
                var mover = colors === BLACK ? RED : BLACK;
                onState(loadShared(placements, mover, 0));
            }
            return;
        }
        for (var t = 0; t < 2; t++) {
            var turn = t === 0 ? BLACK : RED;
            onState(loadShared(placements, turn, 0));
            for (var i = 0; i < placements.length; i++) {
                var p = placements[i];
                if ((p[1] & PAWN) !== turn) continue;
                var g = loadShared(placements, turn, p[0]);
                var moves = g.getMoves();
                if (moves.length > 0 && checkers.isJump(moves[0])) {
                    onState(g);
                }
            }
        }
    }
    function recurse(count, startIdx) {
        if (count === 0) { emit(); return; }
        for (var i = startIdx; i < darkSquares.length; i++) {
            var states = pieceStatesFor(darkSquares[i]);
            for (var s = 0; s < states.length; s++) {
                placements.push([darkSquares[i], states[s]]);
                recurse(count - 1, i + 1);
                placements.pop();
            }
        }
    }
    for (var n = 1; n <= maxPieces; n++) recurse(n, 0);
}

var KIND_HOLE = 0, KIND_MIXED = 1, KIND_ELIMINATED = 2, KIND_MIDJUMP = 3;

// Dense solve. Returns {V, D, kind, slotCount, n, maxPieces, stats}.
function solveDense(maxPieces, forcedJumps, log) {
    log = log || function () {};
    var restoreForced = checkers.getForcedJumps();
    checkers.setForcedJumps(forcedJumps);
    var t0 = Date.now();

    var slotCount = checkers.tablebaseSlotCount(maxPieces);
    var midjumpIds = new Map();

    function idOf(game) {
        var jcl = game.getJumpContinuationLoc();
        if (jcl === 0) {
            return checkers.tablebaseRank(game, maxPieces); // -1 for k<2 single-color
        }
        var key = midjumpKeyOf(game);
        var id = midjumpIds.get(key);
        if (id === undefined) {
            id = slotCount + midjumpIds.size;
            midjumpIds.set(key, id);
        }
        return id;
    }

    // Pass 1: kinds, mid-jump ids, edge counts.
    var kindTmp = new Uint8Array(slotCount);
    var midjumpMoveCounts = [];
    var baseMoveCounts = new Int32Array(slotCount);
    var liveStates = 0;
    enumerateStates(maxPieces, function (game) {
        liveStates++;
        var jcl = game.getJumpContinuationLoc();
        var moves = game.getMoves();
        if (jcl !== 0) {
            idOf(game); // assign id in first-seen order
            midjumpMoveCounts.push(moves.length);
            return;
        }
        var rank = checkers.tablebaseRank(game, maxPieces);
        if (rank < 0) return; // k=1 elimination terminal: children reference it as -1
        var mixed = game.getCheckerCounts()[0] > 0 && game.getCheckerCounts()[1] > 0;
        kindTmp[rank] = mixed ? KIND_MIXED : KIND_ELIMINATED;
        baseMoveCounts[rank] = moves.length;
    });
    var n = slotCount + midjumpIds.size;
    var kind = new Uint8Array(n);
    kind.set(kindTmp);
    for (var m = 0; m < midjumpMoveCounts.length; m++) kind[slotCount + m] = KIND_MIDJUMP;
    log("live states: " + liveStates + " (midjump " + midjumpIds.size + "), id space: " + n +
        "  [" + ((Date.now() - t0) / 1000).toFixed(0) + "s]");

    var edgeStart = new Int32Array(n + 1);
    for (var i = 0; i < slotCount; i++) edgeStart[i + 1] = edgeStart[i] + baseMoveCounts[i];
    for (m = 0; m < midjumpMoveCounts.length; m++) {
        edgeStart[slotCount + m + 1] = edgeStart[slotCount + m] + midjumpMoveCounts[m];
    }
    var E = edgeStart[n];
    var edgeChild = new Int32Array(E);
    var edgeSame = new Uint8Array(E);
    baseMoveCounts = null;
    midjumpMoveCounts = null;
    kindTmp = null;
    log("edges: " + E);

    // Pass 2: fill edges via the engine (makeMove/undo on the shared game).
    var fillPos = Int32Array.from(edgeStart.subarray(0, n));
    enumerateStates(maxPieces, function (game) {
        var id = idOf(game);
        if (id < 0) return;
        var moves = game.getMoves();
        if (moves.length === 0) return;
        var wasBlack = game.turnIsBlack();
        for (var mi = 0; mi < moves.length; mi++) {
            var undo = game.makeMove(moves[mi], true);
            var childId = idOf(game);
            var pos = fillPos[id]++;
            edgeChild[pos] = childId; // -1 = opponent eliminated with 1 piece left... only k=1; k>=2 rank
            edgeSame[pos] = game.turnIsBlack() === wasBlack ? 1 : 0;
            undo();
        }
    });
    fillPos = null;
    checkers.setForcedJumps(restoreForced);
    log("edges filled  [" + ((Date.now() - t0) / 1000).toFixed(0) + "s]");

    // Layered retrograde over a compacting worklist of unlabeled live states.
    var V = new Int8Array(n);
    var D = new Int32Array(n);
    var labeled = new Uint8Array(n);
    var work = new Int32Array(n);
    var workLen = 0;
    for (i = 0; i < n; i++) {
        if (kind[i] === KIND_HOLE) continue;
        if (edgeStart[i + 1] === edgeStart[i]) {
            V[i] = -1; D[i] = 0; labeled[i] = 1; // terminal: no moves
        } else {
            work[workLen++] = i;
        }
    }
    var round = 0;
    var progressed = true;
    while (progressed && workLen > 0) {
        round++;
        progressed = false;
        var w = 0;
        for (var wi = 0; wi < workLen; wi++) {
            var s = work[wi];
            var lo = edgeStart[s], hi = edgeStart[s + 1];
            var minWinVia = -1, maxLossVia = -1;
            var allLosing = true;
            for (var e = lo; e < hi; e++) {
                var cid = edgeChild[e];
                var cv, cd;
                if (cid === -1) { cv = -1; cd = 0; }
                else if (!labeled[cid]) { allLosing = false; continue; }
                else { cv = V[cid]; cd = D[cid]; }
                var moverView = edgeSame[e] ? cv : -cv;
                if (moverView === 1) {
                    allLosing = false;
                    if (minWinVia === -1 || cd < minWinVia) minWinVia = cd;
                } else if (moverView === -1) {
                    if (cd > maxLossVia) maxLossVia = cd;
                } else {
                    allLosing = false;
                }
            }
            if (minWinVia !== -1 && minWinVia === round - 1) {
                V[s] = 1; D[s] = round; labeled[s] = 1; progressed = true;
            } else if (allLosing && maxLossVia === round - 1) {
                V[s] = -1; D[s] = round; labeled[s] = 1; progressed = true;
            } else {
                work[w++] = s;
            }
        }
        workLen = w;
    }

    var wins = 0, losses = 0, live = 0;
    for (i = 0; i < n; i++) {
        if (kind[i] === KIND_HOLE) continue;
        live++;
        if (labeled[i]) { if (V[i] === 1) wins++; else losses++; }
    }
    log("decisive: " + (wins + losses) + " (wins " + wins + ", losses " + losses +
        ", draws " + (live - wins - losses) + ", rounds " + round + ")" +
        "  [" + ((Date.now() - t0) / 1000).toFixed(0) + "s]");

    return { V: V, D: D, kind: kind, labeled: labeled, slotCount: slotCount, n: n,
        maxPieces: maxPieces, forcedJumps: forcedJumps,
        stats: { wins: wins, losses: losses, live: live, rounds: round, midjump: midjumpIds.size } };
}

// Compatibility view for verification: Map stateKey -> {v, d, h0, h1} over
// every solved decisive state, including mid-jump states and elimination
// terminals (matching what the shipped v3 tables store).
function solve(maxPieces, forcedJumps, log) {
    var dense = solveDense(maxPieces, forcedJumps, log);
    var restoreForced = checkers.getForcedJumps();
    checkers.setForcedJumps(forcedJumps);
    var entries = new Map();
    enumerateStates(maxPieces, function (game) {
        var jcl = game.getJumpContinuationLoc();
        var id;
        if (jcl === 0) {
            id = checkers.tablebaseRank(game, maxPieces);
            if (id < 0) {
                // k=1 elimination terminal
                var h1 = game.hashBase();
                entries.set(midjumpKeyOf(game), { v: -1, d: 0, h0: h1.h0, h1: h1.h1 });
                return;
            }
        } else {
            // reuse first-seen order: rebuild the same Map ordering
            id = dense.slotCount + midjumpSeq(game, dense);
        }
        if (!dense.labeled[id]) return;
        var h = game.hashBase();
        entries.set(midjumpKeyOf(game), { v: dense.V[id], d: dense.D[id], h0: h.h0, h1: h.h1 });
    });
    checkers.setForcedJumps(restoreForced);
    return { entries: entries, totalStates: dense.stats.live, rounds: dense.stats.rounds };
}
function midjumpSeq(game, dense) {
    if (!dense.__midjumpMap) {
        dense.__midjumpMap = new Map();
    }
    var key = midjumpKeyOf(game);
    var seq = dense.__midjumpMap.get(key);
    if (seq === undefined) {
        seq = dense.__midjumpMap.size;
        dense.__midjumpMap.set(key, seq);
    }
    return seq;
}

function writeV4(dense, outPath) {
    var slots = dense.slotCount;
    var buffer = Buffer.alloc(16 + slots, 255);
    Buffer.from(checkers.buildTablebaseV4Header(dense.forcedJumps, dense.maxPieces)).copy(buffer, 0);
    for (var i = 0; i < slots; i++) {
        if (dense.kind[i] !== KIND_MIXED) continue; // holes & eliminated: 255
        buffer[16 + i] = dense.labeled[i]
            ? ((dense.V[i] + 1) << 6) | Math.min(dense.D[i], 63)
            : 64; // explicit draw
    }
    fs.writeFileSync(outPath, buffer);
    return slots;
}

function writeV3(solved, forcedJumps, outPath) {
    var list = [];
    solved.entries.forEach(function (e) {
        list.push({ h0: e.h0, h1Hi: (e.h1 >>> 16) & 0xFFFF, h1Lo: e.h1 & 0xFF,
            resultAndDist: ((e.v + 1) << 6) | Math.min(e.d, 63) });
    });
    list.sort(function (a, b) { return a.h0 - b.h0 || a.h1Hi - b.h1Hi || a.h1Lo - b.h1Lo; });
    fs.writeFileSync(outPath, Buffer.from(checkers.buildTablebaseV3(list, forcedJumps)));
    return list.length;
}

if (require.main === module) {
    var args = process.argv.slice(2);
    var wantV3 = args.indexOf('--v3') >= 0;
    args = args.filter(function (a) { return a !== '--v3'; });
    if (args.length !== 3 || (args[1] !== 'forced' && args[1] !== 'unforced')) {
        console.error("usage: node tools/generate-tablebase.js <maxPieces> forced|unforced <out> [--v3]");
        process.exit(2);
    }
    var maxPieces = parseInt(args[0], 10);
    var forced = args[1] === 'forced';
    var t0 = Date.now();
    if (wantV3) {
        var solved = solve(maxPieces, forced, function (m) { console.log(m); });
        console.log("wrote " + writeV3(solved, forced, args[2]) + " v3 entries to " + args[2]);
    } else {
        var dense = solveDense(maxPieces, forced, function (m) { console.log(m); });
        writeV4(dense, args[2]);
        console.log("wrote v4 (" + dense.slotCount + " slots, " +
            (dense.stats.wins + dense.stats.losses) + " decisive) to " + args[2]);
    }
    console.log("total " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
}

module.exports = { solve: solve, solveDense: solveDense, writeV3: writeV3, writeV4: writeV4,
    enumerateStates: enumerateStates, makeGame: makeGame };
