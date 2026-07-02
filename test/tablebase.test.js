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

test('KNOWN BUG #8: shipped end8Unforced tablebase cannot be loaded by ResultList2',
    {
        skip: !fs.existsSync(unforcedPath) && 'end8Unforced not present',
        todo: 'end8Unforced as served is 14,725,120 bytes, which is not divisible by 9, so ' +
              'ResultList2 computes a fractional size and new Uint32Array(buffer, 4*size, size) ' +
              'throws RangeError. In the browser, loadTablebase("unforced") therefore throws ' +
              'inside the XHR onload handler and the unforced tablebase is never installed. ' +
              'Either the published file is corrupt/truncated or its format no longer matches ' +
              'ResultList2; loadTablebase also never checks request.status, so an HTTP error ' +
              'page would be fed to ResultList2 the same way.'
    },
    function () {
        assert.doesNotThrow(function () {
            new checkers.ResultList2(loadBuffer(unforcedPath));
        });
    });
