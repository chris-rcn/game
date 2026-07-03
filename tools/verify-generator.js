"use strict";
// Full <=3-piece verification of the generator against the shipped tables:
// every shipped entry must be present in the solve with an identical VALUE.
// Distances are compared but not required to match: shipped distances are
// non-canonical artifacts of the original bounded forward generation (see
// BUGS.md #12); ours are canonical fastest-win / slowest-loss.
var fs = require('fs');
var path = require('path');
var checkers = require(path.join(__dirname, '..', 'checkers.js'));
var gen = require(path.join(__dirname, 'generate-tablebase.js'));
function load(p) { var b = fs.readFileSync(p); return new checkers.ResultList2(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
var failed = false;
[{ file: 'end8Forced', forced: true }, { file: 'end8Unforced', forced: false }].forEach(function (cfg) {
    var solved = gen.solve(3, cfg.forced, function (m) { console.log('  ' + m); });
    var tb = load(path.join(__dirname, '..', cfg.file));
    var shippedSize = tb.getStats().size;
    var present = 0, valueMismatch = 0, distExact = 0;
    solved.entries.forEach(function (e) {
        var s = tb.getEntry({ h0: e.h0, h1: e.h1 }, 99);
        if (!s) return;
        present++;
        if (s.v !== e.v) valueMismatch++;
        else if (s.d === Math.min(e.d, 63)) distExact++;
    });
    console.log(cfg.file + ': shipped ' + shippedSize + ', present-in-solve ' + present +
        ', value mismatches ' + valueMismatch +
        ', exact-distance ' + (100 * distExact / present).toFixed(1) + '%' +
        ', extra decisive states found ' + (solved.entries.size - present));
    if (present !== shippedSize || valueMismatch !== 0) failed = true;
});
process.exit(failed ? 1 : 0);
