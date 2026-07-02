"use strict";
var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var checkers = require('../checkers.js');

// ResultList2 layout: size = byteLength / 9;
//   Uint32Array h0 at offset 0, Uint32Array h1 at offset 4*size,
//   Uint8Array resultAndDist at offset 8*size.
// resultAndDist encodes value v in {-1,0,1} and distance d in 0..63 as
// ((v+1) << 6) | d.
function buildTablebase(entries) {
    // entries: [{h0, h1, v, d}] — must already be sorted by (h0, h1).
    var size = entries.length;
    var buffer = new ArrayBuffer(size * 9);
    var h0 = new Uint32Array(buffer, 0, size);
    var h1 = new Uint32Array(buffer, 4 * size, size);
    var rd = new Uint8Array(buffer, 8 * size, size);
    entries.forEach(function (e, i) {
        h0[i] = e.h0;
        h1[i] = e.h1;
        rd[i] = ((e.v + 1) << 6) | e.d;
    });
    return buffer;
}

test('ResultList2 decodes stored entries', function () {
    var tb = new checkers.ResultList2(buildTablebase([
        { h0: 100, h1: 5, v: 1, d: 3 },
        { h0: 100, h1: 9, v: -1, d: 0 },
        { h0: 200, h1: 1, v: 0, d: 7 }
    ]));
    assert.strictEqual(tb.getStats().size, 3);
    assert.deepStrictEqual(tb.getEntry({ h0: 100, h1: 5 }, 4), { v: 1, d: 3 });
    assert.deepStrictEqual(tb.getEntry({ h0: 100, h1: 9 }, 4), { v: -1, d: 0 });
    assert.deepStrictEqual(tb.getEntry({ h0: 200, h1: 1 }, 4), { v: 0, d: 7 });
});

test('ResultList2 returns null for absent hashes (including below the minimum h0)', function () {
    var tb = new checkers.ResultList2(buildTablebase([
        { h0: 100, h1: 5, v: 1, d: 3 },
        { h0: 200, h1: 1, v: 0, d: 7 }
    ]));
    // h0 below every stored h0 exercises what used to be the binarySearch
    // ambiguous-zero case (BUG #1, fixed); getEntry always survived it by
    // re-checking h0Array[i].
    assert.strictEqual(tb.getEntry({ h0: 50, h1: 5 }, 2), null);
    assert.strictEqual(tb.getEntry({ h0: 150, h1: 5 }, 2), null);
    assert.strictEqual(tb.getEntry({ h0: 250, h1: 5 }, 2), null);
    assert.strictEqual(tb.getEntry({ h0: 100, h1: 6 }, 2), null);
});

test('ResultList2 maxObservedCheckerCount heuristic: misses below the observed count report a draw', function () {
    var tb = new checkers.ResultList2(buildTablebase([
        { h0: 100, h1: 5, v: 1, d: 3 }
    ]));
    // A hit at checkerCount 5 raises the observed maximum...
    tb.getEntry({ h0: 100, h1: 5 }, 5);
    assert.strictEqual(tb.getMaxObservedCheckerCount(), 5);
    // ...after which a miss with fewer checkers is assumed to be a draw.
    assert.deepStrictEqual(tb.getEntry({ h0: 999, h1: 9 }, 3), { v: 0, d: 0 });
    // Misses at or above the observed count still return null.
    assert.strictEqual(tb.getEntry({ h0: 999, h1: 9 }, 5), null);
});

test('ResultList2 with an empty buffer returns null', function () {
    var tb = new checkers.ResultList2(new ArrayBuffer(0));
    assert.strictEqual(tb.getStats().size, 0);
    assert.strictEqual(tb.getEntry({ h0: 1, h1: 1 }, 2), null);
});

var forcedPath = path.join(__dirname, '..', 'end8Forced');
var unforcedPath = path.join(__dirname, '..', 'end8Unforced');

function loadBuffer(p) {
    var b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

test('shipped end8Forced tablebase loads and is sorted by (h0, h1)',
    { skip: !fs.existsSync(forcedPath) && 'end8Forced not present' },
    function () {
        var tb = new checkers.ResultList2(loadBuffer(forcedPath));
        var size = tb.getStats().size;
        assert.ok(size > 0);
        // Verify the sort invariant getEntry's binary search depends on.
        var buffer = loadBuffer(forcedPath);
        var h0 = new Uint32Array(buffer, 0, size);
        var h1 = new Uint32Array(buffer, 4 * size, size);
        for (var i = 1; i < size; i++) {
            assert.ok(h0[i] > h0[i - 1] || (h0[i] === h0[i - 1] && h1[i] >= h1[i - 1]),
                "entries out of order at index " + i);
        }
    });

test('ResultList2 lookups agree exactly with baseline after the binarySearch fix (BUG #1)',
    { skip: !fs.existsSync(forcedPath) && 'end8Forced not present' },
    function () {
        // getEntry survived the old ambiguous-zero return only because it
        // re-checks h0Array[i]; this proves the convention change is
        // behavior-neutral for the one production caller. Fresh instances and
        // identical probe order keep the maxObservedCheckerCount heuristic in
        // both implementations in the same state.
        var common = require('../common.js');
        var baseline = require('../baseline/checkers.js');
        var tbNew = new checkers.ResultList2(loadBuffer(forcedPath));
        var tbOld = new baseline.ResultList2(loadBuffer(forcedPath));
        var size = tbNew.getStats().size;
        var buffer = loadBuffer(forcedPath);
        var h0 = new Uint32Array(buffer, 0, size);
        var h1 = new Uint32Array(buffer, 4 * size, size);
        var rand = new common.Random(23);
        var probes = [];
        for (var i = 0; i < 500; i++) {
            var idx = rand.int(size);
            probes.push({ h0: h0[idx], h1: h1[idx] });                    // present
            probes.push({ h0: rand.next31(), h1: rand.next31() });        // almost surely absent
            probes.push({ h0: h0[idx], h1: rand.next31() });              // h0 present, h1 absent
        }
        probes.push({ h0: 0, h1: 0 });                                    // below-minimum case
        probes.forEach(function (p, n) {
            var checkerCount = 2 + (n % 5);
            assert.deepStrictEqual(
                tbNew.getEntry(p, checkerCount),
                tbOld.getEntry(p, checkerCount),
                "probe " + n + ": " + JSON.stringify(p));
        });
    });

// Capacity-padded layout (BUG #3): u32 h0 | u16 h1>>>16 | u8 h1&0xFF | u8
// resultAndDist, arrays each allocated for `capacity` entries, used prefix
// sorted by h0, remainder zero-filled.
function buildPaddedTablebase(entries, capacity) {
    var buffer = new ArrayBuffer(capacity * 8);
    var h0 = new Uint32Array(buffer, 0, capacity);
    var hi = new Uint16Array(buffer, 4 * capacity, capacity);
    var lo = new Uint8Array(buffer, 6 * capacity, capacity);
    var rd = new Uint8Array(buffer, 7 * capacity, capacity);
    entries.forEach(function (e, i) {
        h0[i] = e.h0;
        hi[i] = (e.h1 >>> 16) & 0xFFFF;
        lo[i] = e.h1 & 0xFF;
        rd[i] = ((e.v + 1) << 6) | e.d;
    });
    return buffer;
}

test('ResultList2 reads the capacity-padded format (BUG #3, fixed)', function () {
    var tb = new checkers.ResultList2(buildPaddedTablebase([
        { h0: 100, h1: 0x7fff00aa, v: 1, d: 3 },
        { h0: 100, h1: 0x000100bb, v: -1, d: 2 },
        { h0: 200, h1: 0x12345678, v: 0, d: 0 }
    ], 16));
    assert.strictEqual(tb.getStats().size, 3, "trailing zero padding must be trimmed");
    assert.deepStrictEqual(tb.getEntry({ h0: 100, h1: 0x7fff00aa }, 4), { v: 1, d: 3 });
    assert.deepStrictEqual(tb.getEntry({ h0: 100, h1: 0x000100bb }, 4), { v: -1, d: 2 });
    assert.deepStrictEqual(tb.getEntry({ h0: 200, h1: 0x12345678 }, 4), { v: 0, d: 0 });
    // Only 23 bits of h1 are stored; a hash differing in those bits must miss.
    assert.strictEqual(tb.getEntry({ h0: 100, h1: 0x7ffe00aa }, 4), null, "h1 high bits mismatch");
    assert.strictEqual(tb.getEntry({ h0: 100, h1: 0x7fff00ab }, 4), null, "h1 low byte mismatch");
    assert.strictEqual(tb.getEntry({ h0: 50, h1: 1 }, 4), null, "below minimum h0");
    assert.strictEqual(tb.getEntry({ h0: 150, h1: 1 }, 4), null, "absent h0");
});

test('ResultList2 rejects buffers matching neither layout', function () {
    assert.throws(function () {
        new checkers.ResultList2(new ArrayBuffer(13));
    }, /Unrecognized tablebase format/);
});

test('shipped end8Unforced loads via the capacity-padded format and agrees with the engine (BUG #3, fixed)',
    { skip: !fs.existsSync(unforcedPath) && 'end8Unforced not present' },
    function () {
        var common = require('../common.js');
        var tb = new checkers.ResultList2(loadBuffer(unforcedPath));
        assert.strictEqual(tb.getStats().size, 230080);

        // Oracle probe: real unforced endgame positions must decode to sane
        // decisive results (the table stores no draws — absence means draw,
        // which is what the maxObservedCheckerCount heuristic reconstructs).
        checkers.setForcedJumps(false);
        var rand = new common.Random(42);
        var hits = 0, probed = 0;
        var seen = {};
        for (var g0 = 0; g0 < 150 && hits < 30; g0++) {
            var game = new checkers.Game();
            for (var step = 0; step < 400; step++) {
                var mv = game.getMoves();
                if (mv.length === 0) break;
                game.makeMove(mv[rand.int(mv.length)], true);
                if (game.getCheckerCount() <= 3 && game.getMoves().length > 0 &&
                        !game.getJumpContinuationLoc()) {
                    var h = game.hashBase();
                    var key = h.h0 + '_' + h.h1;
                    if (seen[key]) continue;
                    seen[key] = true;
                    probed++;
                    var entry = tb.getEntry(h, game.getCheckerCount());
                    if (entry && !(entry.v === 0 && entry.d === 0)) {
                        hits++;
                        assert.ok(entry.v === 1 || entry.v === -1,
                            "stored entries are decisive, got v=" + entry.v);
                        // No ply-parity assertion: multi-jump continuations
                        // advance the distance counter without switching the
                        // side to move.
                        assert.ok(entry.d >= 0 && entry.d <= 63, "distance in range");
                    }
                }
            }
        }
        checkers.setForcedJumps(true);
        assert.ok(hits >= 20, "expected plenty of real positions in the table, got " + hits + "/" + probed);
    });

test('Search uses the unforced tablebase for exact endgame values',
    { skip: !fs.existsSync(unforcedPath) && 'end8Unforced not present' },
    function () {
        var common = require('../common.js');
        var players = require('../players.js');
        var tb = new checkers.ResultList2(loadBuffer(unforcedPath));
        checkers.setForcedJumps(false);
        // Find a tablebase-covered winning position via seeded playouts.
        var rand = new common.Random(7);
        var found = null;
        for (var g0 = 0; g0 < 300 && !found; g0++) {
            var game = new checkers.Game();
            for (var step = 0; step < 400; step++) {
                var mv = game.getMoves();
                if (mv.length === 0) break;
                game.makeMove(mv[rand.int(mv.length)], true);
                if (game.getCheckerCount() <= 3 && game.getMoves().length > 0 &&
                        !game.getJumpContinuationLoc()) {
                    var entry = tb.getEntry(game.hashBase(), game.getCheckerCount());
                    if (entry && entry.v === 1 && entry.d > 1) {
                        found = JSON.parse(JSON.stringify(game.getState()));
                        break;
                    }
                }
            }
        }
        assert.ok(found, "expected to find a tablebase win");
        var s = new players.Search(4);
        s.evalDither = 0;
        s.tablebase = tb;
        var detail = s.genMoveDetail(new checkers.Game(found));
        checkers.setForcedJumps(true);
        assert.ok(detail.value > 0.9,
            "search should confirm the tablebase win, got " + detail.value);
    });
