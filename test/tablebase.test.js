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

// Canonical shipped files are v3; the original site downloads are kept as
// fixtures for the legacy and capacity-padded reader paths.
var forcedPath = path.join(__dirname, '..', 'end8Forced');
var unforcedPath = path.join(__dirname, '..', 'end8Unforced');
var legacyFixturePath = path.join(__dirname, '..', 'testdata', 'end8Forced.legacy');
var paddedFixturePath = path.join(__dirname, '..', 'testdata', 'end8Unforced.padded');

function loadBuffer(p) {
    var b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

test('legacy end8Forced fixture loads and is sorted by (h0, h1)',
    { skip: !fs.existsSync(legacyFixturePath) && 'fixture not present' },
    function () {
        var tb = new checkers.ResultList2(loadBuffer(legacyFixturePath));
        var size = tb.getStats().size;
        assert.ok(size > 0);
        // Verify the sort invariant getEntry's binary search depends on.
        var buffer = loadBuffer(legacyFixturePath);
        var h0 = new Uint32Array(buffer, 0, size);
        var h1 = new Uint32Array(buffer, 4 * size, size);
        for (var i = 1; i < size; i++) {
            assert.ok(h0[i] > h0[i - 1] || (h0[i] === h0[i - 1] && h1[i] >= h1[i - 1]),
                "entries out of order at index " + i);
        }
    });

test('ResultList2 lookups agree exactly with baseline after the binarySearch fix (BUG #1)',
    { skip: !fs.existsSync(legacyFixturePath) && 'fixture not present' },
    function () {
        // getEntry survived the old ambiguous-zero return only because it
        // re-checks h0Array[i]; this proves the convention change is
        // behavior-neutral for the one production caller. Fresh instances and
        // identical probe order keep the maxObservedCheckerCount heuristic in
        // both implementations in the same state.
        var common = require('../common.js');
        var baseline = require('../baseline/checkers.js');
        var tbNew = new checkers.ResultList2(loadBuffer(legacyFixturePath));
        var tbOld = new baseline.ResultList2(loadBuffer(legacyFixturePath));
        var size = tbNew.getStats().size;
        var buffer = loadBuffer(legacyFixturePath);
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

test('padded end8Unforced fixture loads and agrees with the engine (BUG #3, fixed)',
    { skip: !fs.existsSync(paddedFixturePath) && 'fixture not present' },
    function () {
        var common = require('../common.js');
        var tb = new checkers.ResultList2(loadBuffer(paddedFixturePath));
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

// ---- v3 "CHFT" headered format ----

test('buildTablebaseV3 / ResultList2 v3 round trip with flags', function () {
    var entries = [
        { h0: 100, h1Hi: 0x7fff, h1Lo: 0xaa, resultAndDist: ((1 + 1) << 6) | 3 },
        { h0: 100, h1Hi: 0x0001, h1Lo: 0xbb, resultAndDist: ((-1 + 1) << 6) | 2 },
        { h0: 200, h1Hi: 0x1234, h1Lo: 0x78, resultAndDist: ((0 + 1) << 6) | 0 }
    ];
    [true, false].forEach(function (forced) {
        var tb = new checkers.ResultList2(checkers.buildTablebaseV3(entries, forced));
        assert.strictEqual(tb.getStats().size, 3);
        assert.strictEqual(tb.getStats().forcedJumps, forced);
        assert.deepStrictEqual(tb.getEntry({ h0: 100, h1: 0x7fff00aa }, 4), { v: 1, d: 3 });
        assert.deepStrictEqual(tb.getEntry({ h0: 100, h1: 0x000100bb }, 4), { v: -1, d: 2 });
        assert.deepStrictEqual(tb.getEntry({ h0: 200, h1: 0x12345678 }, 4), { v: 0, d: 0 });
        assert.strictEqual(tb.getEntry({ h0: 100, h1: 0x7ffe00aa }, 4), null, "h1 high bits mismatch");
        assert.strictEqual(tb.getEntry({ h0: 150, h1: 1 }, 4), null);
        assert.deepStrictEqual(tb.entryAt(0), entries[0]);
        assert.deepStrictEqual(tb.entryAt(2), entries[2]);
    });
    // Empty v3 file is valid.
    var empty = new checkers.ResultList2(checkers.buildTablebaseV3([], true));
    assert.strictEqual(empty.getStats().size, 0);
    assert.strictEqual(empty.getEntry({ h0: 1, h1: 1 }, 2), null);
});

test('v3 reader rejects bad version and inconsistent entry counts', function () {
    var good = checkers.buildTablebaseV3(
        [{ h0: 1, h1Hi: 2, h1Lo: 3, resultAndDist: 64 }], true);
    var badVersion = good.slice(0);
    new Uint32Array(badVersion, 0, 4)[1] = 99;
    assert.throws(function () { new checkers.ResultList2(badVersion); },
        /Unsupported tablebase version/);
    var badCount = good.slice(0);
    new Uint32Array(badCount, 0, 4)[2] = 7;
    assert.throws(function () { new checkers.ResultList2(badCount); },
        /header says 7 entries/);
    assert.throws(function () {
        checkers.buildTablebaseV3([
            { h0: 5, h1Hi: 0, h1Lo: 0, resultAndDist: 64 },
            { h0: 4, h1Hi: 0, h1Lo: 0, resultAndDist: 64 }
        ], true);
    }, /sorted/);
});

test('entryAt presents a uniform 23-bit view across all three formats', function () {
    var legacy = new checkers.ResultList2(buildTablebase([{ h0: 9, h1: 0x7abc12ef, v: 1, d: 5 }]));
    assert.deepStrictEqual(legacy.entryAt(0),
        { h0: 9, h1Hi: 0x7abc, h1Lo: 0xef, resultAndDist: ((1 + 1) << 6) | 5 });
    var padded = new checkers.ResultList2(buildPaddedTablebase([{ h0: 9, h1: 0x7abc12ef, v: 1, d: 5 }], 4));
    assert.deepStrictEqual(padded.entryAt(0), legacy.entryAt(0));
});

test('convertBuffer produces lookup-identical v3 tables from both older formats', function () {
    var convert = require('../tools/convert-tablebase.js');
    var entries = [
        { h0: 100, h1: 0x7fff00aa, v: 1, d: 3 },
        { h0: 100, h1: 0x000100bb, v: -1, d: 2 },
        { h0: 200, h1: 0x12345678, v: 0, d: 7 }
    ];
    [buildTablebase(entries), buildPaddedTablebase(entries, 11)].forEach(function (srcBuffer) {
        var v3 = new checkers.ResultList2(convert.convertBuffer(srcBuffer, false));
        var src = new checkers.ResultList2(srcBuffer);
        assert.strictEqual(v3.getStats().size, src.getStats().size);
        assert.strictEqual(v3.getStats().forcedJumps, false);
        entries.forEach(function (e) {
            assert.deepStrictEqual(
                v3.getEntry({ h0: e.h0, h1: e.h1 }, 4),
                src.getEntry({ h0: e.h0, h1: e.h1 }, 4));
        });
        assert.strictEqual(v3.getEntry({ h0: 100, h1: 0x7ffe00aa }, 4), null);
    });
});

test('canonical v3 files match their source fixtures entry-for-entry',
    { skip: !(fs.existsSync(forcedPath) && fs.existsSync(legacyFixturePath) &&
              fs.existsSync(unforcedPath) && fs.existsSync(paddedFixturePath)) && 'files not present' },
    function () {
        [
            { v3: forcedPath, fixture: legacyFixturePath, forced: true, count: 270254 },
            { v3: unforcedPath, fixture: paddedFixturePath, forced: false, count: 230080 }
        ].forEach(function (pair) {
            var tbV3 = new checkers.ResultList2(loadBuffer(pair.v3));
            var tbSrc = new checkers.ResultList2(loadBuffer(pair.fixture));
            assert.strictEqual(tbV3.getStats().size, pair.count);
            assert.strictEqual(tbSrc.getStats().size, pair.count);
            assert.strictEqual(tbV3.getStats().forcedJumps, pair.forced);
            for (var i = 0; i < pair.count; i++) {
                var a = tbV3.entryAt(i), b = tbSrc.entryAt(i);
                if (a.h0 !== b.h0 || a.h1Hi !== b.h1Hi || a.h1Lo !== b.h1Lo ||
                        a.resultAndDist !== b.resultAndDist) {
                    assert.fail(pair.v3 + " entry " + i + " differs: " +
                        JSON.stringify(a) + " vs " + JSON.stringify(b));
                }
            }
        });
    });

test('canonical v3 files contain no 54-bit key collisions (conversion provably lossless)',
    { skip: !(fs.existsSync(forcedPath) && fs.existsSync(unforcedPath)) && 'files not present' },
    function () {
        // v3 keeps 31 h0 bits + 23 h1 bits per entry. Distinct positions
        // colliding on all 54 bits would make lookups ambiguous; this audit
        // proves every stored entry remains uniquely keyed (the legacy
        // forced file was also checked against its full 31-bit h1 before
        // conversion: the dropped bits never disambiguated anything).
        [forcedPath, unforcedPath].forEach(function (p) {
            var tb = new checkers.ResultList2(loadBuffer(p));
            var n = tb.getStats().size;
            var collisions = 0;
            var prev = tb.entryAt(0);
            for (var i = 1; i < n; i++) {
                var e = tb.entryAt(i);
                if (e.h0 === prev.h0) {
                    // walk the whole equal-h0 run pairwise (runs are tiny)
                    var run = [prev, e];
                    while (i + 1 < n) {
                        var next = tb.entryAt(i + 1);
                        if (next.h0 !== e.h0) break;
                        run.push(next);
                        i++;
                    }
                    for (var a = 0; a < run.length; a++) {
                        for (var b = a + 1; b < run.length; b++) {
                            if (run[a].h1Hi === run[b].h1Hi && run[a].h1Lo === run[b].h1Lo) {
                                collisions++;
                            }
                        }
                    }
                    prev = run[run.length - 1];
                } else {
                    prev = e;
                }
            }
            assert.strictEqual(collisions, 0, p + " has ambiguous 54-bit keys");
        });
    });

test('search prefers the shorter tablebase win (distance-decay gradient)', function () {
    var players = require('../players.js');
    var common = require('../common.js');
    // Two black kings vs a red king: every black move keeps a won position.
    // A synthetic tablebase labels the children of two different first moves
    // as red-to-move losses at different distances; the search must follow
    // the shorter one. Run both assignments so move ordering cannot fake it.
    function makeGame() {
        var h = require('./helpers.js');
        return h.makeGame({ turn: 'black', pieces: { 40: 'B', 48: 'B', 2: 'R' } });
    }
    var g = makeGame();
    var moves = g.getMoves();
    assert.ok(moves.length >= 2);
    var mA = moves[0], mB = moves[1];
    function childHash(move) {
        var c = makeGame();
        assert.ok(c.makeMove(new checkers.Move(move.from, move.to), true));
        return c.hashBase();
    }
    var hA = childHash(mA), hB = childHash(mB);
    function entry(h, d) {
        return { h0: h.h0, h1Hi: (h.h1 >>> 16) & 0xFFFF, h1Lo: h.h1 & 0xFF,
            resultAndDist: ((-1 + 1) << 6) | d }; // red to move, losing in d
    }
    [{ dA: 5, dB: 25, expect: mA }, { dA: 25, dB: 5, expect: mB }].forEach(function (c) {
        var entries = [entry(hA, c.dA), entry(hB, c.dB)];
        entries.sort(function (x, y) { return x.h0 - y.h0 || x.h1Hi - y.h1Hi; });
        var tb = new checkers.ResultList2(checkers.buildTablebaseV3(entries, false));
        var s = new players.Search(2);
        s.evalDither = 0;
        s.tablebase = tb;
        var move = s.genMove(makeGame());
        assert.strictEqual(move.from + '>' + move.to, c.expect.from + '>' + c.expect.to,
            "must follow the d=" + Math.min(c.dA, c.dB) + " win");
    });
});

test('Search auto-loads the canonical tablebase under Node (on by default)',
    { skip: !fs.existsSync(unforcedPath) && 'end8Unforced not present' },
    function () {
        var common = require('../common.js');
        var players = require('../players.js');
        var tb = new checkers.ResultList2(loadBuffer(unforcedPath));
        checkers.setForcedJumps(false);
        // Find a covered win DEEP enough that a raw depth-4 search cannot
        // prove it — only a tablebase makes the value near-certain.
        var rand = new common.Random(7);
        var found = null;
        for (var g0 = 0; g0 < 400 && !found; g0++) {
            var game = new checkers.Game();
            for (var step = 0; step < 400; step++) {
                var mv = game.getMoves();
                if (mv.length === 0) break;
                game.makeMove(mv[rand.int(mv.length)], true);
                if (game.getCheckerCount() <= 3 && game.getMoves().length > 0 &&
                        !game.getJumpContinuationLoc()) {
                    var entry = tb.getEntry(game.hashBase(), game.getCheckerCount());
                    if (entry && entry.v === 1 && entry.d >= 13) {
                        found = JSON.parse(JSON.stringify(game.getState()));
                        break;
                    }
                }
            }
        }
        assert.ok(found, "expected to find a deep tablebase win");
        function search(configure) {
            var s = new players.Search(4);
            s.evalDither = 0;
            configure(s);
            return s.genMoveDetail(new checkers.Game(JSON.parse(JSON.stringify(found))));
        }
        var auto = search(function () { /* untouched: auto */ });
        var off = search(function (s) { s.tablebase = null; });
        checkers.setForcedJumps(true);
        assert.ok(auto.value > 0.9,
            "auto-loaded tablebase should prove the win, got " + auto.value);
        assert.ok(off.value < 0.9,
            "with tablebase explicitly off, a depth-4 search cannot prove a d>=13 win, got " + off.value);
    });

test('generator reproduces shipped values for the 2-piece space (fast slice of the full proof)', function () {
    // The full <=3-piece verification (tools/verify-generator.js) shows
    // 100% presence and ZERO value mismatches across all 500,334 shipped
    // entries in both modes; this test keeps a fast slice of that proof in
    // the suite.
    var gen = require('../tools/generate-tablebase.js');
    var tb = new checkers.ResultList2(loadBuffer(forcedPath));
    var solved = gen.solve(2, true, function () {});
    var present = 0, valueMismatch = 0;
    solved.entries.forEach(function (e) {
        var s = tb.getEntry({ h0: e.h0, h1: e.h1 }, 99);
        if (!s) return;
        present++;
        if (s.v !== e.v) valueMismatch++;
    });
    assert.strictEqual(valueMismatch, 0, "solver and shipped table must agree on every value");
    assert.ok(present >= 2770, "2-piece space should overlap substantially, got " + present);
    // Elimination terminals (side to move has no pieces) are stored: v=-1 d=0.
    var helpers = require('./helpers.js');
    var g = helpers.makeGame({ turn: 'red', pieces: { 40: 'B' } });
    assert.deepStrictEqual(tb.getEntry(g.hashBase(), 99), { v: -1, d: 0 });
});

// ---- v4 "CHFI" dense-indexed format ----

test('tablebaseRank is a collision-free dense index over base states', function () {
    var gen = require('../tools/generate-tablebase.js');
    var seen = new Set();
    var slots = checkers.tablebaseSlotCount(2);
    var count = 0;
    gen.enumerateStates(2, function (game) {
        if (game.getJumpContinuationLoc() !== 0) {
            assert.strictEqual(checkers.tablebaseRank(game, 2), -1, "mid-jump states are not ranked");
            return;
        }
        if (game.getCheckerCount() < 2) {
            // Elimination terminals are answered by the search's no-moves
            // path, not stored, hence not rankable.
            assert.strictEqual(checkers.tablebaseRank(game, 2), -1);
            return;
        }
        var rank = checkers.tablebaseRank(game, 2);
        assert.ok(rank >= 0 && rank < slots, "rank in range: " + rank);
        assert.ok(!seen.has(rank), "rank collision at " + rank);
        seen.add(rank);
        count++;
    });
    assert.strictEqual(count, 6976, "mixed-color 2-piece base states, both turns");
    // Out-of-coverage piece counts rank as -1.
    var big = require('./helpers.js').makeGame({ turn: 'black', pieces: { 40: 'b', 48: 'b', 20: 'r' } });
    assert.strictEqual(checkers.tablebaseRank(big, 2), -1);
});

test('TablebaseV4 probe round-trips through a synthetic table', function () {
    var helpers = require('./helpers.js');
    var maxPieces = 2;
    var slots = checkers.tablebaseSlotCount(maxPieces);
    var buffer = new ArrayBuffer(16 + slots);
    new Uint8Array(buffer, 16, slots).fill(255);
    new Uint32Array(buffer, 0, 4).set(new Uint32Array(checkers.buildTablebaseV4Header(true, maxPieces)));
    var g = helpers.makeGame({ turn: 'black', pieces: { 40: 'B', 2: 'R' } });
    var data = new Uint8Array(buffer, 16, slots);
    data[checkers.tablebaseRank(g, maxPieces)] = ((1 + 1) << 6) | 17;   // win in 17
    var draw = helpers.makeGame({ turn: 'red', pieces: { 40: 'B', 2: 'R' } });
    data[checkers.tablebaseRank(draw, maxPieces)] = 64;                 // explicit draw
    var tb = new checkers.TablebaseV4(buffer);
    assert.deepStrictEqual(tb.probe(g), { v: 1, d: 17 });
    assert.deepStrictEqual(tb.probe(draw), { v: 0, d: 0 });
    var absent = helpers.makeGame({ turn: 'black', pieces: { 40: 'B', 4: 'R' } });
    assert.strictEqual(tb.probe(absent), null, "255 means no entry");
    var tooBig = helpers.makeGame({ turn: 'black', pieces: { 40: 'b', 48: 'b', 20: 'r' } });
    assert.strictEqual(tb.probe(tooBig), null, "outside coverage");
    assert.strictEqual(tb.getStats().forcedJumps, true);
    assert.strictEqual(tb.getStats().maxPieces, 2);
    assert.strictEqual(tb.getStats().size, 1, "one decisive entry (draws not counted)");
    // openTablebase sniffs both formats.
    assert.ok(checkers.openTablebase(buffer).probe, "v4 detected by magic");
    assert.ok(checkers.openTablebase(buildTablebase([{ h0: 9, h1: 9, v: 1, d: 1 }])).getEntry,
        "legacy still opens as ResultList2");
    // Truncation is rejected.
    assert.throws(function () { new checkers.TablebaseV4(buffer.slice(0, 1000)); }, /slots|version|CHFI/);
});
