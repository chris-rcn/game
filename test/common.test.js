"use strict";
var test = require('node:test');
var assert = require('node:assert');
var common = require('../common.js');

test('format replaces {} placeholders in order', function () {
    assert.strictEqual(common.format("a={} b={}", 1, "x"), "a=1 b=x");
    assert.strictEqual(common.format("no placeholders"), "no placeholders");
    assert.strictEqual(common.format("{}{}", "a"), "a{}");
});

test('round rounds to the requested number of places', function () {
    assert.strictEqual(common.round(1.2345, 2), 1.23);
    assert.strictEqual(common.round(1.235, 2), 1.24);
    assert.strictEqual(common.round(7.5), 8);
    assert.strictEqual(common.round(-1.25, 1), -1.2);
});

test('coalesce returns first non-null value', function () {
    assert.strictEqual(common.coalesce(null, 5), 5);
    assert.strictEqual(common.coalesce(undefined, 5), 5);
    assert.strictEqual(common.coalesce(0, 5), 0);
    assert.strictEqual(common.coalesce(false, 5), false);
});

test('padLeft / padRight', function () {
    assert.strictEqual(common.padLeft("    ", "ab"), "  ab");
    assert.strictEqual(common.padLeft("    ", undefined), "    ");
    assert.strictEqual(common.padRight("ab", "    "), "ab  ");
    assert.strictEqual(common.padRight(undefined, "    "), "    ");
});

test('assert throws on falsy condition', function () {
    assert.throws(function () { common.assert(false, "boom"); }, /boom/);
    assert.doesNotThrow(function () { common.assert(true); });
});

test('Random is deterministic for a given seed', function () {
    var a = new common.Random(42);
    var b = new common.Random(42);
    for (var i = 0; i < 1000; i++) {
        assert.strictEqual(a.next31(), b.next31());
    }
    var c = new common.Random(43);
    var d = new common.Random(42);
    var same = 0;
    for (i = 0; i < 100; i++) {
        if (c.next31() === d.next31()) same++;
    }
    assert.ok(same < 5, "different seeds should produce different streams");
});

test('Random.next31 is non-negative and 31-bit', function () {
    // The arithmetic >> shifts in the xorshift update cancel the sign bit
    // (bit31 = w31^w31^t31^t31 = 0), so despite using signed shifts the
    // generator really does produce non-negative 31-bit values.
    var r = new common.Random(7);
    for (var i = 0; i < 100000; i++) {
        var v = r.next31();
        assert.ok(v >= 0 && v < 2147483648, "out of range: " + v);
    }
});

test('Random.float in [0,1) and Random.int in [0,n)', function () {
    var r = new common.Random(9);
    for (var i = 0; i < 50000; i++) {
        var f = r.float();
        assert.ok(f >= 0 && f < 1, "float out of range: " + f);
        var n = r.int(10);
        assert.ok(n >= 0 && n < 10 && n === Math.floor(n), "int out of range: " + n);
    }
});

test('shuffle preserves the multiset of elements', function () {
    var r = new common.Random(5);
    var arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    var shuffled = common.shuffle(arr.slice(), r);
    assert.deepStrictEqual(shuffled.slice().sort(function (a, b) { return a - b; }), arr);
});

test('binarySearch finds present elements', function () {
    var arr = [10, 20, 30, 40, 50];
    for (var i = 0; i < arr.length; i++) {
        assert.strictEqual(common.binarySearch(arr, arr[i]), i);
    }
});

test('binarySearch returns a negative value for missing elements above the minimum', function () {
    // The convention here is ~maxIndex == -(insertion point).
    assert.strictEqual(common.binarySearch([10, 20, 30], 15), -1);
    assert.strictEqual(common.binarySearch([10, 20, 30], 25), -2);
    assert.strictEqual(common.binarySearch([10, 20, 30], 35), -3);
});

test('KNOWN BUG #1: binarySearch returns 0 (looks like "found at 0") when target is below all elements',
    { todo: 'binarySearch returns ~maxIndex; when maxIndex ends at -1 that is ~(-1) === 0, ' +
            'which is indistinguishable from a successful match at index 0. ' +
            'Callers using "result >= 0" as a found-test get a false positive.' },
    function () {
        var result = common.binarySearch([10, 20, 30], 5);
        assert.ok(result < 0,
            "expected a negative not-found result, got " + result +
            " which collides with 'found at index 0'");
    });

test('KNOWN BUG #2: SuperRandom is never exported',
    { todo: 'common.js line 145 re-assigns pub.Random = Random instead of pub.SuperRandom = SuperRandom, ' +
            'so the SuperRandom class is unreachable by consumers.' },
    function () {
        assert.strictEqual(typeof common.SuperRandom, 'function');
    });

test('autoScaleFormat basic shapes', function () {
    assert.strictEqual(common.autoScaleFormat(0), "   0");
    assert.strictEqual(common.autoScaleFormat(" x"), " x");
    assert.strictEqual(common.autoScaleFormat(NaN), " NaN");
    // spot check scaling suffixes
    assert.ok(/K$/.test(common.autoScaleFormat(50000)));
    assert.ok(/M$/.test(common.autoScaleFormat(5000000)));
});

test('IirFilter converges toward recent values', function () {
    var f = new common.IirFilter(0.5);
    f.add(10);
    assert.strictEqual(f.value(), 10);
    for (var i = 0; i < 50; i++) f.add(2);
    assert.ok(Math.abs(f.value() - 2) < 0.01);
});
