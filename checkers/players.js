"use strict";

var CHF = CHF || {};

if (typeof require !== 'undefined') {
    CHF.common = require('./common.js');
    CHF.checkers = require('./checkers.js');
}

CHF.checkers.players = function() {
    var common = CHF.common;
    var checkers = CHF.checkers;
    var pub = common.isNodeJs() ? exports : {};
    var fmt = common.format;
    var log = common.log;
    var assert = common.assert;
    var round = common.round;

    var isJumpMove = checkers.isJump;

    // Capability marker: this Search understands tablebase readers that
    // expose probe(game) (the v4 indexed format) in addition to legacy
    // getEntry(hash) readers. Harnesses use it to gate what they inject
    // into older engine versions.
    pub.tablebaseProbe = true;

    // Canonical endgame tablebases, auto-loaded per mode under Node (the
    // browser cannot load synchronously; checkersUi injects after its async
    // fetch). Lazy, cached, and silent when the files are absent.
    var nodeTablebases = {};
    function loadNodeTablebase(forced) {
        var key = forced ? 'forced' : 'unforced';
        if (!(key in nodeTablebases)) {
            nodeTablebases[key] = null;
            try {
                var fs = require('fs');
                var path = require('path');
                var raw = fs.readFileSync(path.join(__dirname, forced ? 'end8Forced' : 'end8Unforced'));
                nodeTablebases[key] = checkers.openTablebase(
                    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
            } catch (e) {
                // stay null: engine plays without a tablebase
            }
        }
        return nodeTablebases[key];
    }

    function Random(seed) {
        var pub = this;
        var skipChecks = true;
        var random = new common.Random(seed);

        function genMove(game) {
            var moves = game.getMoves();
            if (moves.length === 0) {
                return;
            }
            return moves[random.int(moves.length)];
        }
        pub.genMove = genMove;

        function playout(game) {
            // Returns -1/1 result from turn's perspective.
            var forBlack = game.turnIsBlack();
            while (true) {
                var move = genMove(game);
                if (move) {
                    game.makeMove(move, skipChecks);
                } else {
                    break;
                }
            }
            return forBlack === game.turnIsBlack() ? -1 : 1;
        }
        pub.playout = playout;

        function playouts(game, count) {
            // Returns -1 to 1 average result from turn's perspective.
            var sum = 0;
            for (var i=0; i<count; i++) {
                sum += playout(game.copy());
            }
            return sum / count;
        }
        pub.playouts = playouts;

    }
    pub.Random = Random;

    function Search(initialMaxDepth, maxSeconds) {
        assert(initialMaxDepth > 0);
        var random = new common.Random(1);
        var pub = this;
        var currentMaxDepth;
        // Child values are scaled by this so depth breaks ties toward shorter
        // paths; child windows must be pre-divided by it so the child prunes
        // against the same thresholds the parent compares after scaling.
        var valueDecay = 0.99999;
        pub.logDepth = -1;
        pub.maxDepth = initialMaxDepth;
        // undefined = auto (Node: load the mode-matching canonical file;
        // browser: none until injected). null = explicitly off. An object is
        // used as given. Tablebases are on unless they need to be off.
        pub.tablebase = undefined;
        var activeTablebase;
        // Pawns are worth 1. Learned by arena self-play (both modes, depths
        // 4 and 6, ~2200 games): every candidate below the original 2.0 beat
        // it and every candidate above lost; 1.4 — the checkers-literature
        // ballpark — scored 53.7% ± 3.1 against 2.0 over 1000 games.
        pub.kingValue = 1.4;
        // Extra worth of a pawn still guarding the back row.  Learned by
        // arena self-play vs 0 (all candidates 0.05-0.4 won; 0.1 peaked):
        // 59.4% ± 3.4 over 800 games at depth 4, 53.3% at depth 5, with
        // kingValue=1.4 re-verified as stable alongside it.
        pub.homeRowValue = 0.1;
        // Per edge-distance step (0..3) of each king, pricing mobility and
        // corner-trappability. REJECTED before repetition handling existed
        // (mixed signs — centralization edges dissipated into shuffling and
        // adjudicated draws), then RETESTED and ADOPTED once repetitionDraws
        // gave uncovered endgames fresh-ground exploration to steer: all
        // scan cells positive under current defaults, 0.05 confirmed at
        // 55.1%/51.0% ± 4.9 over 800 games at depth 4, kingValue 1.4
        // re-verified stable alongside it.
        pub.kingCenterValue = 0.05;
        // Extra worth of a pawn whose forward cone to the kinging row holds
        // no enemy piece (an uncontested coronation beyond the horizon,
        // discounted from the kinging gain kingValue-1 = 0.4).  Learned by
        // arena self-play vs 0: every candidate 0.1-0.3 won BOTH modes;
        // 0.2 confirmed at 52.5%/53.3% ± 4.9 over 800 games at depth 4,
        // with kingValue=1.4 re-verified as stable alongside it.
        pub.runawayValue = 0.2;
        // Rejected candidates (rankValue, supportValue, homeRowFullSupport,
        // runawayGraded, mobilityValue) were removed after arena testing;
        // README.md keeps the measurements.
        // Per capture move available to the SIDE TO MOVE at eval time, in
        // final-eval units. The refined survivor of the rejected mobility
        // idea: slides carry no signal (measured harmful at every weight),
        // but available jumps signal material about to be won — exactly at
        // the leaves where the quiescence budget ran out. ADOPTED by arena:
        // scan single-peaked (0.01 and 0.03 positive all cells, 0.08
        // collapses to ~36%), 0.03 confirmed at 57.3%/57.3% ± 4.8 vs 0
        // over 800 games at depth 4 (+51 Elo both modes) — the strongest
        // confirmed eval term since the back-row bonus.
        pub.captureThreatValue = 0.03;
        pub.evalFunction = function(game, depth, moves) {
            var e = game.materialEval(pub.kingValue, pub.homeRowValue,
                pub.kingCenterValue, pub.runawayValue);
            if (pub.captureThreatValue && moves && moves.length &&
                    isJumpMove(moves[0])) {
                // Jumps are generated before slides, so moves[0] is a jump
                // iff any jump exists; count the jump prefix.
                var jumps = 1;
                while (jumps < moves.length && isJumpMove(moves[jumps])) {
                    jumps++;
                }
                e += pub.captureThreatValue * jumps;
            }
            return e;
        };
        // Uniform ±d/2 noise on each leaf eval: above the valueDecay
        // tie-break scale, below the learned eval terms. Originally 0.001
        // for game variety; 0.003 was adopted on arena evidence — scan
        // positive both modes and 400 games/mode confirmation at
        // 53.6%/54.8% ± 4.9 vs 0.001 (~+29 Elo pooled). Mechanism is
        // consistent with the Beal effect: small noise at fixed depth
        // implicitly rewards mobility. Larger values (0.01, 0.03) measured
        // flat-to-mixed, not harmful — dither is a robust knob here.
        pub.evalDither = 0.003;
        // Extension budget beyond maxDepth while a capture is pending (or
        // the move is forced): 0 = none (evaluate at the bare horizon),
        // Infinity = extend until quiet.  Generalizes the old doQuiesce
        // boolean (false ≡ 0, true ≡ Infinity).  Default 1 is the measured
        // best Elo-per-time in both modes (+232/+129 per doubling at depth
        // 4); at FIXED depth more budget is stronger — set Infinity for
        // full quiescence.
        pub.quiesceDepth = 1;
        pub.doAlphaBeta = true;
        pub.evalCounter = 0;
        // On by default since the depth-comparison fix (BUGS.md #4):
        // value-neutral at fixed depth and roughly halves leaf evaluations.
        pub.useTranspositionTable = true;
        pub.typicalDepth = new common.IirFilter(1);
        pub.useIterativeDeepening = false;
        pub.useKillerMove = true;
        // Node-budgeted search: when > 0, genMove runs iterative deepening
        // and keeps deepening while the TOTAL nodes spent on this move stay
        // affordable — it never starts an iteration it predicts will bust
        // the budget (estimated from the observed per-iteration growth),
        // and it always completes depth 1. Budgets meter thinking EFFORT:
        // device-independent, deterministic, and self-allocating (sparse
        // endgames search deeper than crowded midgames for the same spend).
        // maxDepth remains a hard cap on top. pub.lastNodeCount reports the
        // spend of the most recent genMove for calibration and tests.
        pub.nodeLimit = 0;
        pub.lastNodeCount = 0;
        var nodeCount = 0;
        // The game has no repetition rule (draws are positional facts), but
        // returning to a position already seen in the actual game line has
        // provably achieved nothing: any win available now was available at
        // the first visit.  With repetitionDraws on, the search scores any
        // in-tree return to a previously faced position (or to an ancestor
        // on the current search line) as a draw (0) — the side that is
        // ahead steers away from shuffling, the side that is behind steers
        // toward it, which is the correct game-theoretic posture for both.
        // On by default: it cannot cost a win (a revisited position's win
        // was available at the first visit), it ends the shuffle failure
        // mode outright (24 repeated positions in 60 plies -> 0 in the
        // pinned 2Kv1K test), and the arena confirmed a small gain on top:
        // 52.5%/51.5% ± 4.9 vs off over 400 games/mode at depth 4.
        pub.repetitionDraws = true;
        var lineHistory = {};
        var linePath = [];
        var lineCheckerCount = Infinity;
        function clearLineHistory() {
            lineHistory = {};
            lineCheckerCount = Infinity;
        }
        pub.clearLineHistory = clearLineHistory;
        var transpositionTable;
        var TT_EXACT = 0;
        var TT_LOWERBOUND = 1;
        var TT_UPPERBOUND = 2;
        function logIndented(depth, message) {
            if (depth <= pub.logDepth) {
                console.log(new Array(depth + 2).join("   ") + message);
            }
        }
        function negamax(game, depth, alpha, beta, killer) {
            // returns { move, value, distanceFromRoot }

            nodeCount++;
            var alphaOrig = alpha;
            var result = {};
            var hash = game.hashBase();
            // Repetition check comes BEFORE the transposition table and the
            // tablebase: the draw score is path-dependent (it exists because
            // of where the game has already been), so neither cache may
            // override it.  Skipped at the root, where a move must be chosen.
            var repetitionKey = null;
            if (pub.repetitionDraws) {
                repetitionKey = hash.h0 + "," + hash.h1;
                if (depth > 0 &&
                        (lineHistory[repetitionKey] || linePath.indexOf(repetitionKey) >= 0)) {
                    result.value = 0;
                    result.valueIsKnown = false;
                    result.distanceFromRoot = depth;
                    return result;
                }
            }
            // Entries are keyed on remaining search depth below the node, not
            // distance from the root: a cached value is reusable only if it
            // was searched at least as deep as this node needs.  Nodes at or
            // beyond currentMaxDepth are all in the same quiescence regime,
            // whose result does not depend on depth, so their remaining depth
            // is equivalently 0.
            var remaining = Math.max(0, currentMaxDepth - depth);
            if (pub.useTranspositionTable) {
                var ttEntry = transpositionTable[hash.h0];
                if (ttEntry && ttEntry.h1 === hash.h1 && ttEntry.r >= remaining) {
                    if (ttEntry.f === TT_EXACT) {
                        result.value = ttEntry.v;
                        result.valueIsKnown = false;
                        result.distanceFromRoot = depth;
                        return result;
                    } else if (ttEntry.f === TT_LOWERBOUND) {
                        alpha = Math.max(alpha, ttEntry.v);
                    } else if (ttEntry.f === TT_UPPERBOUND) {
                        beta = Math.min(beta, ttEntry.v);
                    }
                    if (alpha >= beta) {
                        result.value = ttEntry.v;
                        result.valueIsKnown = false;
                        result.distanceFromRoot = depth;
                        return result;
                    }
                }
            }

            if (activeTablebase && depth > 0) {
                var tbEntry = activeTablebase.probe ?
                    activeTablebase.probe(game) : activeTablebase.getEntry(hash);
                if (tbEntry) {
                    // Decay by distance-to-result so tablebase hits carry a
                    // conversion gradient in the search's own tie-break
                    // currency: without it every winning move ties at v and
                    // the engine meanders inside won regions (and the
                    // defender fails to drag losses out).
                    result.value = tbEntry.v * Math.pow(valueDecay, tbEntry.d);
                    result.valueIsKnown = true;
                    result.distanceFromRoot = depth + tbEntry.d;
                    return result;
                }
            }
            result.distanceFromRoot = depth;
            var moves = game.getMoves();
            if (moves.length === 0) {
                result.move = null;
                result.value = -1;
                result.valueIsKnown = true;
                return result;
            }
            var standPat = null;
            if (depth >= currentMaxDepth) {
                // Continue on forced move or jumps.  Jumps are generated
                // before slides, so moves[0] is a jump iff any jump is
                // available; the last move is a slide in unforced mode even
                // when captures are pending.
                var firstIsJump = isJumpMove(moves[0]);
                var canContinue = depth - currentMaxDepth < pub.quiesceDepth &&
                    (moves.length === 1 || firstIsJump);
                if (!canContinue) {
                    pub.evalCounter++;
                    var evaluation = pub.evalFunction(game, depth, moves);
                    result.value = evaluation + pub.evalDither * (random.float() - 0.5);
                    result.valueIsKnown = (Math.abs(result.value) === 1);
                    return result;
                }
                if (firstIsJump && !isJumpMove(moves[moves.length - 1])) {
                    // Mixed list: captures are optional here (unforced mode).
                    // Search only the jumps, with the static eval as the
                    // stand-pat floor; searching the slides too would recurse
                    // without bound.
                    pub.evalCounter++;
                    standPat = pub.evalFunction(game, depth, moves) + pub.evalDither * (random.float() - 0.5);
                    moves = moves.filter(isJumpMove);
                    if (pub.doAlphaBeta && standPat > alpha) {
                        alpha = standPat;
                    }
                }
                //logIndented(depth, fmt("In unlimited quiescence search at depth {}", depth));
            }
            if (moves.length === 1 && depth === 0) {
                moves[0].forced = true;
                result.move = moves[0]; // only value that matters at depth 0
                return result;
            }
            var m;
            if (killer) {
                for (m=1; m<moves.length; m++) {
                    if (moves[m].from === killer.from && moves[m].to === killer.to) {
                        moves[m] = moves[0];
                        moves[0] = killer;
                        break;
                    }
                }
            }
            result.value = -1e9;
            result.distanceFromRoot = 1e9;
            if (repetitionKey !== null) {
                linePath.push(repetitionKey); // on-path for the subtree below
            }
            //logIndented(depth, fmt("{} has {} options", game.turnIsBlack() ? "Black" : "Red", moves.length));
            for (m=0; m<moves.length; m++) {
                var move = moves[m];
                var initialTurnIsBlack = game.turnIsBlack();
                var undo = game.makeMove(move, true /*skipChecks*/);
                assert(undo, "search generated an illegal move");
                //logIndented(depth, fmt("{} to {}...", move.from, move.to));
                var childResult;
                if (game.turnIsBlack() === initialTurnIsBlack) {
                    childResult = negamax(game, depth+1, alpha/valueDecay, beta/valueDecay);
                } else {
                    childResult = negamax(game, depth+1, -beta/valueDecay, -alpha/valueDecay);
                    childResult.value *= -1;
                }
                undo();
                childResult.value *= valueDecay; // causes depth to be a factor when value is otherwise equal.
                //logIndented(depth, fmt("{} to {} has eval {}", move.from, move.to, round(childResult.value, 2)));
                assert(childResult.value >= 0 || childResult.value <= 0, "childResult.value=" + childResult.value);
                if (childResult.value > result.value) {
                    result.value = childResult.value;
                    result.move = move;
                    result.distanceFromRoot = childResult.distanceFromRoot;
                    result.valueIsKnown = childResult.valueIsKnown;
                }
                if (pub.doAlphaBeta) {
                    if (childResult.value > alpha) {
                        //logIndented(depth, fmt("Updating alpha {}->{}", alpha, childResult.value));
                        alpha = childResult.value;
                    }
                    if (alpha >= beta) {
                        //logIndented(depth, fmt("AB cutoff.  {}>={}", alpha, beta));
                        break;
                    }
                }
            }
            if (repetitionKey !== null) {
                linePath.pop();
            }
            if (standPat !== null && standPat > result.value) {
                result.value = standPat;
                result.move = null;
                result.distanceFromRoot = depth;
                result.valueIsKnown = false;
            }
            if (pub.useTranspositionTable) {
                ttEntry = {};
                ttEntry.h1 = hash.h1;
                ttEntry.v = result.value;
                if (result.value <= alphaOrig) {
                    ttEntry.f = TT_UPPERBOUND;
                } else if (result.value >= beta) {
                    ttEntry.f = TT_LOWERBOUND;
                } else {
                    ttEntry.f = TT_EXACT;
                }
                ttEntry.r = remaining;
                transpositionTable[hash.h0] = ttEntry;
            }
            return result;
        }

        function genMove(game) {
            return genMoveDetail(game).move;
        }
        pub.genMove = genMove;

        function genMoveDetail(game) {
            // returns { move, value, distanceFromRoot }
            assert(pub.maxDepth > 0);
            // Resolve per call so a mode change picks up the right table.
            activeTablebase = pub.tablebase !== undefined ? pub.tablebase :
                (common.isNodeJs() ? loadNodeTablebase(checkers.getForcedJumps()) : null);
            if (pub.repetitionDraws) {
                // Material never grows within a game, so a rising checker
                // count means a new game (or an undo): stale line history
                // would poison it with positions from an abandoned line.
                // Drivers that reuse a player can also clearLineHistory().
                var checkerCount = game.getCheckerCount();
                if (checkerCount > lineCheckerCount) {
                    clearLineHistory();
                }
                lineCheckerCount = checkerCount;
                var rootHash = game.hashBase();
                lineHistory[rootHash.h0 + "," + rootHash.h1] = true;
                linePath = [];
            }
            nodeCount = 0;
            if (pub.useIterativeDeepening || maxSeconds > 0 || pub.nodeLimit > 0) {
                var limitSec = maxSeconds > 0 ? 0.4 * maxSeconds : Infinity;
                var killer = null;
                var startMs = common.nowMs();
                var prevIterNodes = 0;
                for (currentMaxDepth=1; ; currentMaxDepth+=1) {
                    transpositionTable = {};
                    var iterStartNodes = nodeCount;
                    // negamax returns the result wrapper; the Move (and its
                    // .forced flag) live on result.move.
                    var result = negamax(game, 0, -1e9, 1e9, killer);
                    var iterNodes = nodeCount - iterStartNodes;
                    if (result.move && !result.move.forced) {
                        var budgetExhausted = false;
                        if (pub.nodeLimit > 0) {
                            // Predict the next iteration from the observed
                            // growth ratio, clamped to [2, 8] against
                            // quiescence noise; before a ratio exists, use
                            // the clamp floor (the measured depth-1 -> 2
                            // increment is ~1.4x, and a default of 3 made
                            // the level-2 budget refuse an affordable
                            // second iteration).
                            var growth = prevIterNodes > 0 ?
                                Math.min(8, Math.max(2, iterNodes / prevIterNodes)) : 2;
                            budgetExhausted = nodeCount + iterNodes * growth > pub.nodeLimit;
                        }
                        if (budgetExhausted || common.elapsedSec(startMs) > limitSec ||
                                currentMaxDepth >= pub.maxDepth) {
                            pub.typicalDepth.add(currentMaxDepth);
                            pub.lastNodeCount = nodeCount;
                            return result;
                        }
                        prevIterNodes = iterNodes;
                        if (pub.useKillerMove) {
                            killer = result.move;
                        }
                    } else {
                        // Forced move or game over: deepening cannot change
                        // the answer.
                        pub.lastNodeCount = nodeCount;
                        return result;
                    }
                }
            }
            transpositionTable = {};
            currentMaxDepth = pub.maxDepth;
            pub.typicalDepth.add(currentMaxDepth);
            var fixedResult = negamax(game, 0, -1e9, 1e9);
            pub.lastNodeCount = nodeCount;
            return fixedResult;
        }
        pub.genMoveDetail = genMoveDetail;
    }
    pub.Search = Search;

    return pub;
}();
