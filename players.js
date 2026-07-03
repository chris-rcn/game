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
                nodeTablebases[key] = new checkers.ResultList2(
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
        pub.rankValue = 0; // per-rank pawn advancement, in pawn units
        // Extra worth of a pawn still guarding the back row.  Learned by
        // arena self-play vs 0 (all candidates 0.05-0.4 won; 0.1 peaked):
        // 59.4% ± 3.4 over 800 games at depth 4, 53.3% at depth 5, with
        // kingValue=1.4 re-verified as stable alongside it.
        pub.homeRowValue = 0.1;
        pub.supportValue = 0; // per friendly piece diagonally behind a pawn
        pub.homeRowFullSupport = false; // back-row pawn counts as 2 supports
        pub.evalFunction = function(game) {
            return game.materialEval(pub.kingValue, pub.rankValue, pub.homeRowValue,
                pub.supportValue, pub.homeRowFullSupport);
        };
        pub.evalDither = 0.001;
        // Extension budget beyond maxDepth while a capture is pending (or
        // the move is forced): 0 = none (evaluate at the bare horizon),
        // Infinity = extend until quiet.  Generalizes the old doQuiesce
        // boolean (false ≡ 0, true ≡ Infinity) so intermediate strengths
        // exist between "horizon-blind" and "full quiescence".
        pub.quiesceDepth = Infinity;
        pub.doAlphaBeta = true;
        pub.evalCounter = 0;
        // On by default since the depth-comparison fix (BUGS.md #4):
        // value-neutral at fixed depth and roughly halves leaf evaluations.
        pub.useTranspositionTable = true;
        pub.typicalDepth = new common.IirFilter(1);
        pub.useIterativeDeepening = false;
        pub.useKillerMove = true;
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

            var alphaOrig = alpha;
            var result = {};
            var hash = game.hashBase();
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
                var tbEntry = activeTablebase.getEntry(hash);
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
            if (pub.useIterativeDeepening || maxSeconds > 0) {
                var limitSec = maxSeconds > 0 ? 0.4 * maxSeconds : Infinity;
                var killer = null;
                var startMs = common.nowMs();
                for (currentMaxDepth=1; ; currentMaxDepth+=1) {
                    transpositionTable = {};
                    // negamax returns the result wrapper; the Move (and its
                    // .forced flag) live on result.move.
                    var result = negamax(game, 0, -1e9, 1e9, killer);
                    if (result.move && !result.move.forced) {
                        if (common.elapsedSec(startMs) > limitSec || currentMaxDepth >= pub.maxDepth) {
                            pub.typicalDepth.add(currentMaxDepth);
                            return result;
                        }
                        if (pub.useKillerMove) {
                            killer = result.move;
                        }
                    } else {
                        // Forced move or game over: deepening cannot change
                        // the answer.
                        return result;
                    }
                }
            }
            transpositionTable = {};
            currentMaxDepth = pub.maxDepth;
            pub.typicalDepth.add(currentMaxDepth);
            return negamax(game, 0, -1e9, 1e9);
        }
        pub.genMoveDetail = genMoveDetail;
    }
    pub.Search = Search;

    return pub;
}();
