"use strict";
var test = require('node:test');
var assert = require('node:assert');
var checkers = require('../checkers.js');
var common = require('../common.js');
var players = require('../players.js');
var h = require('./helpers.js');

// checkers.js keeps module-level state (jumpsAreForced). Make sure every test
// starts from the default.
test.beforeEach(function () {
    checkers.setForcedJumps(true);
});

test('initial position: 12 pieces each, black to move, 7 opening moves', function () {
    var g = new checkers.Game();
    assert.deepStrictEqual(g.getCheckerCounts(), [12, 12]);
    assert.strictEqual(g.getCheckerCount(), 24);
    assert.ok(g.turnIsBlack());
    assert.strictEqual(g.getMoves().length, 7);
    assert.strictEqual(g.getJumpContinuationLoc(), 0);
    assert.strictEqual(g.materialEvalBlack(), 0.5);
    assert.strictEqual(g.toCompactString(), "rrrrrrrrrrrr........bbbbbbbbbbbb (b)");
});

test('coordToLoc / locToCoord round-trip', function () {
    for (var row = 0; row < 8; row++) {
        for (var col = 0; col < 8; col++) {
            var loc = checkers.coordToLoc(row, col);
            var coord = checkers.locToCoord(loc);
            assert.strictEqual(coord.row, row);
            assert.strictEqual(coord.column, col);
        }
    }
});

test('squareToIndex / indexToSquare round-trip over the 32 playable squares', function () {
    var darks = h.darkSquares();
    assert.strictEqual(darks.length, 32);
    darks.forEach(function (loc, i) {
        assert.strictEqual(checkers.squareToIndex(loc), i);
        assert.strictEqual(checkers.indexToSquare(i), loc);
    });
});

test('directionToIndex / indexToDirection round-trip', function () {
    [8, 10, -8, -10].forEach(function (dir) {
        var i = checkers.directionToIndex(dir);
        assert.strictEqual(checkers.indexToDirection(i), dir);
        // jump offsets map to the same direction index
        assert.strictEqual(checkers.directionToIndex(2 * dir), i);
    });
});

test('otherColor flips between BLACK and RED', function () {
    assert.strictEqual(checkers.otherColor(h.BLACK), h.RED);
    assert.strictEqual(checkers.otherColor(h.RED), h.BLACK);
});

test('isJump distinguishes jumps from slides', function () {
    assert.ok(checkers.isJump(new checkers.Move(48, 32)));
    assert.ok(checkers.isJump(new checkers.Move(32, 48)));
    assert.ok(!checkers.isJump(new checkers.Move(48, 40)));
    assert.ok(!checkers.isJump(new checkers.Move(40, 48)));
});

test('pawn slides forward to either open diagonal', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 2: 'r' } });
    assert.deepStrictEqual(h.moveSet(g), ['40>30', '40>32']);
    var undo = g.makeMove(new checkers.Move(40, 32));
    assert.ok(undo);
    assert.ok(!g.turnIsBlack(), "turn should pass to red after a slide");
    assert.ok(g.isBlack(32));
    assert.ok(g.isOpen(40));
});

test('edge pieces do not wrap around the board', function () {
    // Black pawn on the left edge: only one forward slide.
    var g = h.makeGame({ turn: 'black', pieces: { 46: 'b', 2: 'r' } });
    assert.deepStrictEqual(h.moveSet(g), ['46>38']);
    // Red pawn on the right edge: only one forward slide.
    g = h.makeGame({ turn: 'red', pieces: { 26: 'r', 64: 'b' } });
    assert.deepStrictEqual(h.moveSet(g), ['26>34']);
});

test('illegal moves are rejected by checked makeMove', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 48: 'b', 2: 'r' } });
    assert.strictEqual(g.makeMove(new checkers.Move(2, 12)), false, "cannot move opponent piece");
    assert.strictEqual(g.makeMove(new checkers.Move(48, 40)), false, "cannot slide onto occupied square");
    assert.strictEqual(g.makeMove(new checkers.Move(40, 50)), false, "pawn cannot slide backward");
    assert.strictEqual(g.makeMove(new checkers.Move(40, 22)), false, "cannot teleport");
    assert.strictEqual(g.makeMove(new checkers.Move(40, 41)), false, "cannot move to a light square");
});

test('pawn cannot jump backward', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 48: 'r' } });
    assert.strictEqual(g.makeMove(new checkers.Move(40, 56)), false);
});

test('jump captures the intermediate piece', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 32: 'r', 26: 'r' } });
    // Forced-jump mode: the jump is the only legal move.
    assert.deepStrictEqual(h.moveSet(g), ['40>24']);
    assert.ok(g.hasAnyJump());
    var undo = g.makeMove(new checkers.Move(40, 24));
    assert.ok(undo);
    assert.ok(g.isOpen(32), "captured piece removed");
    assert.ok(g.isBlack(24));
    assert.deepStrictEqual(g.getCheckerCounts(), [1, 1]);
    assert.ok(!g.turnIsBlack(), "single jump with no continuation ends the turn");
    h.assertListsConsistent(g);
});

test('jump is rejected when the landing square is occupied or there is no victim', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 32: 'r', 24: 'r' } });
    assert.strictEqual(g.makeMove(new checkers.Move(40, 24)), false, "landing square occupied");
    g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 2: 'r' } });
    assert.strictEqual(g.makeMove(new checkers.Move(40, 24)), false, "no piece to capture");
    g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 32: 'b', 2: 'r' } });
    assert.strictEqual(g.makeMove(new checkers.Move(40, 24)), false, "cannot capture own piece");
});

test('forced jumps suppress slides when a jump exists', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 32: 'r', 64: 'b' } });
    assert.deepStrictEqual(h.moveSet(g), ['40>24'], "only the jump is offered");
    assert.strictEqual(g.makeMove(new checkers.Move(64, 56)), false, "slide rejected while a jump exists");
    assert.strictEqual(g.makeMove(new checkers.Move(40, 30)), false, "even the jumper cannot slide");
});

test('unforced mode offers jumps and slides together', function () {
    checkers.setForcedJumps(false);
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 32: 'r', 64: 'b' } });
    assert.deepStrictEqual(h.moveSet(g), ['40>24', '40>30', '64>56']);
    var undo = g.makeMove(new checkers.Move(64, 56));
    assert.ok(undo, "slide is legal in unforced mode even when a jump exists");
});

test('multi-jump: same player continues, other moves rejected mid-chain', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 48: 'b', 64: 'b', 40: 'r', 22: 'r' } });
    assert.deepStrictEqual(h.moveSet(g), ['48>32']);
    g.makeMove(new checkers.Move(48, 32));
    assert.ok(g.turnIsBlack(), "turn continues during a jump chain");
    assert.strictEqual(g.getJumpContinuationLoc(), 32);
    assert.deepStrictEqual(h.moveSet(g), ['32>12'], "only the continuation jump is legal");
    assert.strictEqual(g.makeMove(new checkers.Move(32, 24)), false, "jumper cannot slide mid-chain");
    assert.strictEqual(g.makeMove(new checkers.Move(64, 56)), false, "other pieces cannot move mid-chain");
    g.makeMove(new checkers.Move(32, 12));
    assert.ok(!g.turnIsBlack(), "turn ends when the chain is exhausted");
    assert.strictEqual(g.getJumpContinuationLoc(), 0);
    assert.deepStrictEqual(g.getCheckerCounts(), [2, 0]);
});

test('pawn is crowned by sliding onto the back row and the turn ends', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 12: 'b', 70: 'r' } });
    var undo = g.makeMove(new checkers.Move(12, 4));
    assert.ok(undo);
    assert.ok(g.isKing(4));
    assert.ok(!g.turnIsBlack());
});

test('pawn crowned by a jump stops jumping even if another jump is available', function () {
    // Black jumps 20 over 12 landing on 4 (back row). A continuation jump
    // 4 over 14 to 24 would exist, but crowning ends the turn (standard rule).
    var g = h.makeGame({ turn: 'black', pieces: { 20: 'b', 12: 'r', 14: 'r' } });
    assert.deepStrictEqual(h.moveSet(g), ['20>4']);
    g.makeMove(new checkers.Move(20, 4));
    assert.ok(g.isKing(4));
    assert.ok(!g.turnIsBlack(), "crowning ends the turn even mid-chain");
    assert.strictEqual(g.getJumpContinuationLoc(), 0);
});

test('red pawn is crowned on row 7', function () {
    var g = h.makeGame({ turn: 'red', pieces: { 58: 'r', 2: 'b' } });
    g.makeMove(new checkers.Move(58, 66));
    assert.ok(g.isKing(66));
});

test('kings move and capture in all four directions', function () {
    var g = h.makeGame({ turn: 'red', pieces: { 40: 'R', 2: 'b' } });
    assert.deepStrictEqual(h.moveSet(g), ['40>30', '40>32', '40>48', '40>50']);
    // King captures backward.
    g = h.makeGame({ turn: 'red', pieces: { 40: 'R', 32: 'b' } });
    assert.deepStrictEqual(h.moveSet(g), ['40>24']);
    var undo = g.makeMove(new checkers.Move(40, 24));
    assert.ok(undo);
    assert.deepStrictEqual(g.getCheckerCounts(), [0, 1]);
});

test('a player with pieces but no legal moves has an empty move list (loses)', function () {
    // Black pawn at 64: 54 is off-board, 56 is blocked, and the jump landing
    // square 48 is blocked, so black has no moves.
    var g = h.makeGame({ turn: 'black', pieces: { 64: 'b', 56: 'r', 48: 'r' } });
    assert.deepStrictEqual(g.getMoves(), []);
});

test('no moves when either side has no pieces', function () {
    var g = h.makeGame({ turn: 'red', pieces: { 40: 'b' } });
    assert.deepStrictEqual(g.getMoves(), []);
});

test('movesSinceProgress: king slide increments, pawn slide and jumps reset', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'B', 2: 'R' }, movesSinceProgress: 5 });
    g.makeMove(new checkers.Move(40, 48));
    assert.strictEqual(g.getMovesSinceProgress(), 6, "king slide is not progress");

    g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 2: 'R' }, movesSinceProgress: 5 });
    g.makeMove(new checkers.Move(40, 32));
    assert.strictEqual(g.getMovesSinceProgress(), 0, "pawn advance is progress");

    g = h.makeGame({ turn: 'black', pieces: { 48: 'B', 40: 'r' }, movesSinceProgress: 5 });
    g.makeMove(new checkers.Move(48, 32));
    assert.strictEqual(g.getMovesSinceProgress(), 0, "capture is progress");
});

test('undo restores exact state for slides, jumps and crowning', function () {
    function checkUndo(game, move) {
        var before = JSON.stringify(game.getState());
        var beforeHash = JSON.stringify(game.hash(true));
        var undo = game.makeMove(move);
        assert.ok(undo, "move should be legal: " + move.from + ">" + move.to);
        undo();
        h.assertListsConsistent(game);
        var afterHash = JSON.stringify(game.hash(true));
        assert.strictEqual(afterHash, beforeHash, "hash restored");
        var after = JSON.parse(JSON.stringify(game.getState()));
        var orig = JSON.parse(before);
        // Piece list order may differ after undo; compare sorted.
        [h.BLACK, h.RED].forEach(function (c) {
            orig.checkers[c].sort(function (a, b) { return a - b; });
            after.checkers[c].sort(function (a, b) { return a - b; });
        });
        orig.legalMoves = null;
        after.legalMoves = null;
        assert.deepStrictEqual(after, orig);
    }
    checkUndo(h.makeGame({ turn: 'black', pieces: { 40: 'b', 2: 'r' } }), new checkers.Move(40, 32));
    checkUndo(h.makeGame({ turn: 'black', pieces: { 40: 'b', 32: 'r' } }), new checkers.Move(40, 24));
    checkUndo(h.makeGame({ turn: 'black', pieces: { 12: 'b', 70: 'r' } }), new checkers.Move(12, 4));
    checkUndo(h.makeGame({ turn: 'black', pieces: { 20: 'b', 12: 'r', 14: 'r' } }), new checkers.Move(20, 4));
    checkUndo(h.makeGame({ turn: 'red', pieces: { 40: 'R', 32: 'b' } }), new checkers.Move(40, 24));
});

test('zobrist hash is identical for transposed move orders', function () {
    var a = new checkers.Game();
    a.makeMove(new checkers.Move(48, 40));
    a.makeMove(new checkers.Move(22, 30));
    a.makeMove(new checkers.Move(50, 42));

    var b = new checkers.Game();
    b.makeMove(new checkers.Move(50, 42));
    b.makeMove(new checkers.Move(22, 30));
    b.makeMove(new checkers.Move(48, 40));

    assert.strictEqual(a.toCompactString(), b.toCompactString());
    assert.deepStrictEqual(a.hash(true), b.hash(true));
    assert.deepStrictEqual(a.hashBase(), b.hashBase());
});

test('hash changes when the position changes', function () {
    var g = new checkers.Game();
    var before = JSON.stringify(g.hash(true));
    g.makeMove(new checkers.Move(48, 40));
    assert.notStrictEqual(JSON.stringify(g.hash(true)), before);
});

test('swapTurnCopy flips the turn but not the board', function () {
    var g = new checkers.Game();
    var swapped = g.swapTurnCopy();
    assert.ok(g.turnIsBlack());
    assert.ok(!swapped.turnIsBlack());
    assert.strictEqual(swapped.toCompactString().slice(0, 32), g.toCompactString().slice(0, 32));
});

test('copy is independent of the original', function () {
    var g = new checkers.Game();
    var c = g.copy();
    g.makeMove(new checkers.Move(48, 40));
    assert.strictEqual(c.toCompactString(), "rrrrrrrrrrrr........bbbbbbbbbbbb (b)");
});

test('getMoves returns a defensive copy', function () {
    var g = new checkers.Game();
    var moves = g.getMoves();
    moves.length = 0;
    assert.strictEqual(g.getMoves().length, 7);
});

test('materialEvalBlack weights kings double', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'B', 48: 'B', 2: 'r' } });
    // black = 2 kings = 4, red = 1 pawn = 1 -> 4/5
    assert.strictEqual(g.materialEvalBlack(), 0.8);
    assert.ok(Math.abs(g.materialEval() - (2 * 0.8 - 1)) < 1e-12);
    var swapped = g.swapTurnCopy();
    assert.ok(Math.abs(swapped.materialEval() + (2 * 0.8 - 1)) < 1e-12);
});

test('forwardRank counts from each side\'s home row', function () {
    var g = new checkers.Game(); // forwardRank is an instance method
    assert.strictEqual(g.forwardRank(2, h.RED), 0);
    assert.strictEqual(g.forwardRank(70, h.RED), 7);
    assert.strictEqual(g.forwardRank(70, h.BLACK), 0);
    assert.strictEqual(g.forwardRank(2, h.BLACK), 7);
});

test('randomBoard places the requested number of pieces', function () {
    checkers.seed(12345);
    for (var i = 0; i < 20; i++) {
        var g = new checkers.Game();
        g.randomBoard(8, true, false);
        assert.strictEqual(g.getCheckerCount(), 8);
        h.assertListsConsistent(g);
    }
});

test('KNOWN BUG #3: randomBoard(unbalanced) can exceed maxCheckersPerPlayer',
    { todo: 'The per-color cap uses `var deployed = { BLACK: 0, RED: 0 }` (string keys) but indexes ' +
            'it with the numeric color constants 1/2, so deployed[color]++ produces NaN and the cap ' +
            'check never fires. One side routinely receives more than 12 pieces.' },
    function () {
        checkers.seed(1);
        var worst = 0;
        for (var i = 0; i < 300; i++) {
            var g = new checkers.Game();
            g.randomBoard(24, true, true);
            var counts = g.getCheckerCounts();
            worst = Math.max(worst, counts[0], counts[1]);
        }
        assert.ok(worst <= 12, "a side received " + worst + " pieces; cap should be 12");
    });

test('property: random self-play preserves invariants and every move survives undo/redo', function () {
    checkers.seed(11);
    var rand = new common.Random(99);
    var totalPlies = 0;
    for (var gi = 0; gi < 50; gi++) {
        var g = new checkers.Game();
        var lastCount = g.getCheckerCount();
        for (var step = 0; step < 400; step++) {
            var moves = g.getMoves();
            if (moves.length === 0) break;
            var move = moves[rand.int(moves.length)];
            var beforeHash = JSON.stringify(g.hash(true));
            var undo = g.makeMove(move, true);
            assert.ok(undo, "listed move must be accepted");
            h.assertListsConsistent(g);
            undo();
            assert.strictEqual(JSON.stringify(g.hash(true)), beforeHash, "undo must restore the hash");
            g.makeMove(move, true);
            var count = g.getCheckerCount();
            assert.ok(count <= lastCount, "piece count must never increase");
            lastCount = count;
            totalPlies++;
        }
        assert.strictEqual(g.getMoves().length, 0, "seeded random game should reach a terminal position");
    }
    assert.ok(totalPlies > 1000);
});

test('property: checked makeMove accepts exactly the moves in getMoves (both jump modes)', function () {
    [true, false].forEach(function (forced) {
        checkers.setForcedJumps(forced);
        checkers.seed(17);
        var rand = new common.Random(5);
        var deltas = [8, 10, -8, -10, 16, 20, -16, -20];
        for (var gi = 0; gi < 5; gi++) {
            var g = new checkers.Game();
            for (var step = 0; step < 120; step++) {
                var moves = g.getMoves();
                if (moves.length === 0) break;
                var legal = {};
                moves.forEach(function (m) { legal[m.from + '>' + m.to] = true; });
                for (var from = 1; from <= 72; from++) {
                    for (var d = 0; d < deltas.length; d++) {
                        var to = from + deltas[d];
                        if (to < 1 || to > 72) continue;
                        var accepted = !!g.copy().makeMove(new checkers.Move(from, to));
                        assert.strictEqual(accepted, !!legal[from + '>' + to],
                            "forced=" + forced + " move " + from + ">" + to +
                            " accepted=" + accepted + " but listed=" + !!legal[from + '>' + to]);
                    }
                }
                g.makeMove(moves[rand.int(moves.length)], true);
            }
        }
    });
    checkers.setForcedJumps(true);
});

test('DESIGN GAP #4: drawThreshold is tracked but never ends the game',
    { todo: 'The engine maintains movesSinceProgress and exposes getDrawThreshold(), but no code ' +
            'path ever declares a draw: getMoves() stays non-empty forever in a king-vs-king ' +
            'shuffle, so a game can never terminate as a draw (the browser UI would ping-pong ' +
            'endlessly with two computer players).' },
    function () {
        var g = h.makeGame({
            turn: 'black',
            pieces: { 64: 'B', 8: 'R' },
            movesSinceProgress: checkers.getDrawThreshold() + 10
        });
        assert.strictEqual(g.getMoves().length, 0,
            "expected the game to be over (drawn) after " + g.getMovesSinceProgress() +
            " moves without progress");
    });
