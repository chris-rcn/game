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

    var boardSize = checkers.getBoardSize();
    var maxDiagonalOffset = boardSize + 2;

    function isJumpMove(move) {
        return Math.abs(move.from - move.to) > maxDiagonalOffset;
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
        pub.tablebase = null;
        pub.evalFunction = function(game) {
            return game.materialEval();
        };
        pub.evalDither = 0.001;
        pub.doQuiesce = true;
        pub.doAlphaBeta = true;
        pub.evalCounter = 0;
        pub.useTranspositionTable = false;
        pub.typicalDepth = new common.IirFilter(1);
        pub.useIterativeDeepening = false;
        pub.useKillerMove = true;
        var ttSize;
        var transpositionTable;
        var TT_EXACT = 0;
        var TT_LOWERBOUND = 1;
        var TT_UPPERBOUND = 2;
        function logIndented(depth, message) {
            if (depth <= pub.logDepth) {
                console.log(new Array(depth + 2).join("   ") + message);
            }
        }
        function negamax(game, depth, alpha, beta, color, killer) {
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

            if (pub.tablebase && depth > 0) {
                var tbEntry = pub.tablebase.getEntry(hash);
                if (tbEntry) {
                    result.value = tbEntry.v;
                    result.valueIsKnown = true;
                    result.distanceFromRoot = depth + tbEntry.d;
                    //logIndented(depth, fmt("Found {} in tablebase: value={}", JSON.stringify(hash), tbEntry.v));
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
                var canContinue = pub.doQuiesce && (moves.length === 1 || firstIsJump);
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
                var undo;
                assert(undo = game.makeMove(move, true /*skipChecks*/));
                //logIndented(depth, fmt("{} to {}...", move.from, move.to));
                var childResult;
                if (game.turnIsBlack() === initialTurnIsBlack) {
                    childResult = negamax(game, depth+1, alpha/valueDecay, beta/valueDecay, color);
                } else {
                    childResult = negamax(game, depth+1, -beta/valueDecay, -alpha/valueDecay, -color);
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
                ttSize++;
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
            if (pub.useIterativeDeepening || maxSeconds > 0) {
                var limitSec = 0.4 * maxSeconds;
                var killer = null;
                var startMs = common.nowMs();
                for (currentMaxDepth=1; ; currentMaxDepth+=1) {
                    transpositionTable = {};
                    ttSize = 0;
                    // negamax returns the result wrapper; the Move (and its
                    // .forced flag) live on result.move.
                    var result = negamax(game, 0, -1e9, 1e9, 1, killer);
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
            ttSize = 0;
            currentMaxDepth = pub.maxDepth;
            pub.typicalDepth.add(currentMaxDepth);
            return negamax(game, 0, -1e9, 1e9, 1);
        }
        pub.genMoveDetail = genMoveDetail;
    }
    pub.Search = Search;

    return pub;
}();
