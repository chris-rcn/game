"use strict";
var test = require('node:test');
var assert = require('node:assert');
var checkers = require('../checkers.js');
var players = require('../players.js');
var h = require('./helpers.js');

test.beforeEach(function () {
    checkers.setForcedJumps(true);
});

function newSearch(depth, opts) {
    opts = opts || {};
    var s = new players.Search(depth, opts.maxSeconds);
    s.evalDither = 0; // deterministic
    if (opts.tt) s.useTranspositionTable = true;
    if (opts.ab === false) s.doAlphaBeta = false;
    if (opts.id) s.useIterativeDeepening = true;
    return s;
}

test('Random player: genMove returns a legal move, deterministically per seed', function () {
    var g = new checkers.Game();
    var p1 = new players.Random(7);
    var p2 = new players.Random(7);
    for (var i = 0; i < 20; i++) {
        var legal = h.moveSet(g);
        var m1 = p1.genMove(g);
        var m2 = p2.genMove(g);
        assert.ok(legal.indexOf(m1.from + '>' + m1.to) >= 0, "move must be legal");
        assert.deepStrictEqual(m1, m2, "same seed, same move");
        g.makeMove(m1, true);
        if (g.getMoves().length === 0) break;
    }
});

test('Random player: genMove returns undefined when no moves exist', function () {
    var g = h.makeGame({ turn: 'red', pieces: { 40: 'b' } });
    assert.strictEqual(new players.Random(1).genMove(g), undefined);
});

test('playout returns +/-1 from the mover\'s perspective', function () {
    // Black jumps red's last piece; red then has no moves, so black (the
    // side to move at the start) wins: +1.
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 32: 'r' } });
    var p = new players.Random(3);
    assert.strictEqual(p.playout(g.copy()), 1);
    assert.strictEqual(p.playouts(g, 10), 1);
    // From a position with no moves at all, the mover has already lost: -1.
    var lost = h.makeGame({ turn: 'red', pieces: { 40: 'b' } });
    assert.strictEqual(p.playout(lost.copy()), -1);
});

test('playout results stay in [-1, 1] from the opening', function () {
    checkers.seed(2);
    var p = new players.Random(11);
    var avg = p.playouts(new checkers.Game(), 20);
    assert.ok(avg >= -1 && avg <= 1, "average out of range: " + avg);
});

test('Search prefers a winning capture and reports a near-won value', function () {
    // Unforced mode so the root has a genuine choice (a single legal move
    // takes negamax's depth-0 shortcut, which returns no value at all).
    checkers.setForcedJumps(false);
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 64: 'b', 32: 'r' } });
    assert.deepStrictEqual(h.moveSet(g), ['40>24', '40>30', '64>56']);
    var detail = newSearch(4).genMoveDetail(g);
    assert.strictEqual(detail.move.from, 40);
    assert.strictEqual(detail.move.to, 24);
    assert.ok(detail.value > 0.99, "capturing the last piece should evaluate as a win, got " + detail.value);
});

test('Search takes the capture over a quiet move in unforced mode', function () {
    checkers.setForcedJumps(false);
    var g = h.makeGame({ turn: 'black', pieces: { 40: 'b', 32: 'r', 26: 'r' } });
    var move = newSearch(4).genMove(g);
    assert.strictEqual(move.from + '>' + move.to, '40>24');
});

test('quiescence engages in unforced mode: depth-1 search sees the recapture (BUG #11, fixed)', function () {
    // Same poisoned-capture setup as below but in unforced mode at depth 1.
    // The recapture by the king on 42 lies beyond the search horizon, so only
    // quiescence can see it. The original code tested whether the LAST
    // generated move was a jump — always a slide in unforced mode — so
    // quiescence never ran and the search grabbed the poisoned piece (48>32).
    checkers.setForcedJumps(false);
    var g = h.makeGame({ turn: 'black', pieces: { 48: 'b', 38: 'r', 40: 'r', 42: 'R' } });
    var detail = newSearch(1).genMoveDetail(g);
    assert.strictEqual(detail.move.from + '>' + detail.move.to, '48>28',
        "quiescence must reveal the recapture after 48>32");
});

test('Search avoids the poisoned capture', function () {
    // Black pawn 48 must jump (forced) and can capture either 38 (landing 28,
    // safe) or 40 (landing 32, where the red king on 42 immediately recaptures
    // and black loses its only piece). The search must pick 48>28. The
    // defender must sit BEHIND the landing square (hence a king): any red
    // piece diagonally ahead of 32 would itself be eaten by the forced jump
    // continuation.
    var g = h.makeGame({ turn: 'black', pieces: { 48: 'b', 38: 'r', 40: 'r', 42: 'R' } });
    assert.deepStrictEqual(h.moveSet(g), ['48>28', '48>32']);
    var detail = newSearch(3).genMoveDetail(g);
    assert.strictEqual(detail.move.from + '>' + detail.move.to, '48>28');
});

test('Search on the opening position returns one of the legal moves', function () {
    var g = new checkers.Game();
    var legal = h.moveSet(g);
    [1, 2, 4].forEach(function (depth) {
        var move = newSearch(depth).genMove(g.copy());
        assert.ok(legal.indexOf(move.from + '>' + move.to) >= 0, "depth " + depth);
    });
});

test('Search with a lost position reports value near -1', function () {
    // Red to move with no pieces able to move: immediate loss.
    var g = h.makeGame({ turn: 'red', pieces: { 40: 'b' } });
    var detail = newSearch(2).genMoveDetail(g);
    assert.strictEqual(detail.value, -1);
    assert.strictEqual(detail.move, null);
});

test('Search under iterative deepening returns the only legal move when forced', function () {
    var g = h.makeGame({ turn: 'black', pieces: { 64: 'b', 2: 'r' } });
    assert.deepStrictEqual(h.moveSet(g), ['64>56']);
    var detail = newSearch(3, { maxSeconds: 5 }).genMoveDetail(g);
    assert.strictEqual(detail.move.from + '>' + detail.move.to, '64>56');
});

test('KNOWN BUG #5: forced-move flag is checked on the wrong object, so the killer-move ' +
     'and forced-move logic in genMoveDetail never fires',
    { todo: 'negamax sets .forced on result.move (the Move object) but genMoveDetail tests ' +
            'move.forced on the result wrapper, which is always undefined. Consequences: ' +
            '(a) the forced-move early exit is dead code — the loop deepens to maxDepth anyway; ' +
            '(b) killer = move stores the wrapper (which has no from/to), so the killer-move ' +
            'ordering optimization never matches and silently no-ops.' },
    function () {
        var g = h.makeGame({ turn: 'black', pieces: { 64: 'b', 2: 'r' } });
        var detail = newSearch(3, { maxSeconds: 5 }).genMoveDetail(g);
        // The Move object is flagged...
        assert.strictEqual(detail.move.forced, true);
        // ...but genMoveDetail looked for the flag here, where it never exists:
        assert.strictEqual(detail.forced, true,
            "genMoveDetail checks `move.forced` on the result wrapper; it is undefined");
    });

test('KNOWN BUG #6: transposition table changes search results (depth comparison is inverted)',
    { todo: 'ttEntry.d stores distance-from-root, and the reuse condition `ttEntry.d >= depth` ' +
            'therefore accepts entries that were searched to LESS remaining depth than the ' +
            'current node needs. Root values differ between TT on and TT off on the same ' +
            'position. (useTranspositionTable defaults to false, so the shipped UI is unaffected.)' },
    function () {
        // Midgame position captured from seeded self-play; reconstructing from the
        // full state JSON preserves internal piece-list order, which move
        // generation (and therefore this repro) depends on.
        var state = JSON.parse('{"turn":2,"jumpContinuationLoc":0,"squares":[null,null,8,null,8,null,2,null,2,null,8,null,8,null,8,null,2,null,null,null,8,null,8,null,8,null,1,null,1,null,5,null,8,null,2,null,null,null,8,null,8,null,8,null,8,null,8,null,8,null,8,null,8,null,null,null,1,null,8,null,1,null,1,null,1,null,1,null,1,null,1],"movesSinceProgress":0,"legalMoves":null,"checkers":[null,[30,70,68,26,56,28,60,62,64,66],[16,34,6,8]]}');
        var g = new checkers.Game(state);
        var off = newSearch(8).genMoveDetail(g.copy());
        var on = newSearch(8, { tt: true }).genMoveDetail(g.copy());
        assert.ok(Math.abs(off.value - on.value) < 1e-9,
            "TT off=" + off.value + " vs TT on=" + on.value);
    });

test('KNOWN BUG #7: alpha-beta pruning changes the root value (depth-decay applied outside the window)',
    { todo: 'negamax multiplies each child value by 0.99999 AFTER the child was searched with ' +
            'undecayed (alpha, beta) bounds, so values at the window edges are pruned ' +
            'inconsistently. Root values differ between doAlphaBeta on and off by ~1e-5 ' +
            'relative, which can flip the chosen move on near-ties.' },
    function () {
        var g = h.fromCompact('rrrrrrrrr.r...r..b..bbrbb.bbbbbb', 'b');
        var on = newSearch(6).genMoveDetail(g.copy());
        var off = newSearch(6, { ab: false }).genMoveDetail(g.copy());
        assert.ok(Math.abs(on.value - off.value) < 1e-9,
            "alpha-beta on=" + on.value + " vs off=" + off.value);
    });
