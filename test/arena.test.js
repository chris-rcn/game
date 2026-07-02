"use strict";
var test = require('node:test');
var assert = require('node:assert');
var arena = require('../arena.js');

test('new and baseline engines load as independent module instances', function () {
    var neo = arena.loadEngine('new');
    var old = arena.loadEngine('baseline');
    assert.notStrictEqual(neo.checkers, old.checkers);
    assert.notStrictEqual(neo.common, old.common);
    assert.notStrictEqual(neo.players, old.players);
    // Module-level state must not leak between the copies.
    neo.checkers.setForcedJumps(true);
    old.checkers.setForcedJumps(false);
    assert.strictEqual(neo.checkers.getForcedJumps(), true);
    assert.strictEqual(old.checkers.getForcedJumps(), false);
    old.checkers.setForcedJumps(true);
});

test('game state transfers across engine versions via getState JSON', function () {
    var neo = arena.loadEngine('new');
    var old = arena.loadEngine('baseline');
    [neo, old].forEach(function (e) { e.checkers.setForcedJumps(true); });
    var g = new neo.checkers.Game();
    g.makeMove(new neo.checkers.Move(48, 40));
    g.makeMove(new neo.checkers.Move(22, 30));
    var state = JSON.parse(JSON.stringify(g.getState()));
    var g2 = new old.checkers.Game(state);
    assert.strictEqual(g2.toCompactString(), g.toCompactString());
    assert.deepStrictEqual(g2.hash(true), g.hash(true));
    assert.deepStrictEqual(
        g2.getMoves().map(function (m) { return m.from + '>' + m.to; }).sort(),
        g.getMoves().map(function (m) { return m.from + '>' + m.to; }).sort());
});

test('playGame terminates and reports a coherent result', function () {
    var neo = arena.loadEngine('new');
    neo.checkers.setForcedJumps(true);
    var players = {};
    players[arena.BLACK] = arena.makePlayer({ engine: 'new', type: 'random', seed: 7 });
    players[arena.RED] = arena.makePlayer({ engine: 'new', type: 'random', seed: 8 });
    var result = arena.playGame(neo, players, [], { drawPlies: 50, maxPlies: 400, shadowEngine: null });
    assert.ok([0, 1, 2].indexOf(result.winner) >= 0);
    assert.ok(result.plies > 0 && result.plies <= 400);
    assert.ok(['no-moves', 'draw-no-progress', 'draw-max-plies'].indexOf(result.reason) >= 0);
});

test('self-play match (new vs new) is exactly color-symmetric', function () {
    // Paired games share an opening with colors swapped, and players are
    // created fresh per game, so identical versions must mirror exactly.
    var match = arena.playMatch({
        games: 6, depth: 2, seed: 3,
        a: { engine: 'new', type: 'search', depth: 2 },
        b: { engine: 'new', type: 'search', depth: 2 },
        forcedModes: [true, false],
        drawPlies: 40, maxPlies: 200, openingPlies: 6
    });
    match.results.forEach(function (stats) {
        assert.strictEqual(stats.games, 6);
        assert.strictEqual(stats.aWins + stats.bWins + stats.draws, 6);
        assert.strictEqual(stats.aWins, stats.bWins, "identical engines must tie the match");
        assert.strictEqual(stats.aWinsAsBlack, stats.bWinsAsBlack);
        assert.strictEqual(stats.aWinsAsRed, stats.bWinsAsRed);
    });
});

test('new vs baseline (currently identical code) shows zero divergences and a tied match', function () {
    var match = arena.playMatch({
        games: 4, depth: 2, seed: 5,
        forcedModes: [true, false],
        drawPlies: 40, maxPlies: 200, openingPlies: 6
    });
    assert.strictEqual(match.options.verify, true, "cross-version match should verify by default");
    match.results.forEach(function (stats) {
        assert.strictEqual(stats.games, 4);
        assert.deepStrictEqual(stats.divergences, [],
            "identical rules must not diverge: " + JSON.stringify(stats.divergences[0]));
        assert.strictEqual(stats.aWins, stats.bWins, "identical engines must tie the match");
    });
});

test('match results are deterministic for a given seed', function () {
    function run() {
        var match = arena.playMatch({
            games: 4, depth: 2, seed: 9, forcedModes: [true],
            drawPlies: 40, maxPlies: 200, verify: false
        });
        var s = match.results[0];
        return [s.aWins, s.bWins, s.draws, s.totalPlies].join(',');
    }
    assert.strictEqual(run(), run());
});

test('arena leaves both engine copies back in forced-jumps mode', function () {
    arena.playMatch({ games: 2, depth: 1, forcedModes: [false], verify: false,
        drawPlies: 30, maxPlies: 100 });
    assert.strictEqual(arena.loadEngine('new').checkers.getForcedJumps(), true);
    assert.strictEqual(arena.loadEngine('baseline').checkers.getForcedJumps(), true);
});
