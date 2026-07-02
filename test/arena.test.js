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

test('new vs baseline shows zero rules divergences; forced mode still ties exactly', function () {
    // The quiescence fix (BUGS.md #11) makes the versions differ in unforced
    // mode, but it provably cannot change forced-mode play (all-jump move
    // lists behave identically), and it never touches the rules, so the
    // shadow replay must stay divergence-free in both modes.
    var match = arena.playMatch({
        games: 4, depth: 2, seed: 5,
        forcedModes: [true, false],
        drawPlies: 40, maxPlies: 200, openingPlies: 6
    });
    assert.strictEqual(match.options.verify, true, "cross-version match should verify by default");
    match.results.forEach(function (stats) {
        assert.strictEqual(stats.games, 4);
        assert.deepStrictEqual(stats.divergences, [],
            "search-only fix must not diverge on rules: " + JSON.stringify(stats.divergences[0]));
        if (stats.forced) {
            assert.strictEqual(stats.aWins, stats.bWins,
                "forced-mode play is bit-identical, so the match must tie exactly");
        }
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

test('makePlayer applies Search feature flags and rejects unknown ones', function () {
    var p = arena.makePlayer({
        engine: 'new', type: 'search', depth: 3,
        searchOptions: { useTranspositionTable: true, useIterativeDeepening: true, evalDither: 0 }
    });
    assert.strictEqual(p.inner.useTranspositionTable, true);
    assert.strictEqual(p.inner.useIterativeDeepening, true);
    assert.strictEqual(p.inner.evalDither, 0);
    assert.ok(p.label.indexOf('useTranspositionTable=true') >= 0, "label should show enabled features");
    assert.throws(function () {
        arena.makePlayer({ engine: 'new', type: 'search', depth: 3, searchOptions: { useTranspositonTable: true } });
    }, /unknown Search option/);
});

test('a crashing player forfeits the game but does not crash the match', function () {
    var neo = arena.loadEngine('new');
    neo.checkers.setForcedJumps(true);
    var players = {};
    players[arena.BLACK] = { label: 'boom', genMove: function () { throw new Error('kaboom'); } };
    players[arena.RED] = arena.makePlayer({ engine: 'new', type: 'random', seed: 4 });
    var result = arena.playGame(neo, players, [], { drawPlies: 50, maxPlies: 100, shadowEngine: null });
    assert.strictEqual(result.winner, arena.RED);
    assert.strictEqual(result.reason, 'player-error');
    assert.strictEqual(result.playerError.by, 'boom');
    assert.match(result.playerError.error, /kaboom/);
});

test('a player returning an illegal move forfeits with the move recorded', function () {
    var neo = arena.loadEngine('new');
    neo.checkers.setForcedJumps(true);
    var players = {};
    players[arena.BLACK] = { label: 'cheat', genMove: function () { return { from: 2, to: 70 }; } };
    players[arena.RED] = arena.makePlayer({ engine: 'new', type: 'random', seed: 4 });
    var result = arena.playGame(neo, players, [], { drawPlies: 50, maxPlies: 100, shadowEngine: null });
    assert.strictEqual(result.winner, arena.RED);
    assert.strictEqual(result.reason, 'illegal-move');
    assert.deepStrictEqual(result.illegalMove.move, { from: 2, to: 70 });
});

test('match with transposition table and iterative deepening enabled runs alarm-free', function () {
    // Exercises the gated Search code paths (needed to arena-test fixes for
    // BUGS.md #4 and #5) end to end.
    var featureOptions = { useTranspositionTable: true, useIterativeDeepening: true };
    var match = arena.playMatch({
        games: 2, seed: 21, forcedModes: [true, false],
        a: { engine: 'new', type: 'search', depth: 3, searchOptions: featureOptions },
        b: { engine: 'baseline', type: 'search', depth: 3, searchOptions: featureOptions },
        drawPlies: 40, maxPlies: 150, openingPlies: 6
    });
    match.results.forEach(function (stats) {
        assert.strictEqual(stats.games, 2);
        assert.deepStrictEqual(stats.playerErrors, []);
        assert.deepStrictEqual(stats.illegalMoves, []);
        assert.deepStrictEqual(stats.divergences, []);
    });
});

test('playMatch reports alarms, including self-play asymmetry detection scaffolding', function () {
    // Identical configs => mirror pairing must tie exactly and produce no
    // alarms; this is the determinism regression tripwire.
    var spec = { engine: 'new', type: 'search', depth: 2, searchOptions: {} };
    var match = arena.playMatch({
        games: 4, seed: 13, forcedModes: [true],
        a: JSON.parse(JSON.stringify(spec)), b: JSON.parse(JSON.stringify(spec)),
        drawPlies: 40, maxPlies: 150, verify: false
    });
    assert.deepStrictEqual(match.alarms, []);
    assert.strictEqual(match.results[0].aWins, match.results[0].bWins);
});

test('arena leaves both engine copies back in forced-jumps mode', function () {
    arena.playMatch({ games: 2, depth: 1, forcedModes: [false], verify: false,
        drawPlies: 30, maxPlies: 100 });
    assert.strictEqual(arena.loadEngine('new').checkers.getForcedJumps(), true);
    assert.strictEqual(arena.loadEngine('baseline').checkers.getForcedJumps(), true);
});
