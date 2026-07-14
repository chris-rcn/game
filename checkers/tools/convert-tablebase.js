"use strict";
// Convert a tablebase file (legacy 9-byte or capacity-padded 8-byte) to the
// v3 "CHFT" headered format: 16-byte header (magic, version, entryCount,
// flags with bit0 = jumpsAreForced) + exact-sized 8-byte-per-entry arrays.
// v3 keeps the padded format's leaner 23-bit h1 entries, the legacy format's
// exact sizing (no zero padding), and adds unambiguous detection.
//
// Usage: node tools/convert-tablebase.js <input> <output> forced|unforced

var fs = require('fs');
var path = require('path');
var checkers = require(path.join(__dirname, '..', 'checkers.js'));

function convertBuffer(buffer, forcedJumps) {
    if (new DataView(buffer).getUint32(0, true) === 0x49464843) { // "CHFI"
        throw new Error("input is a v4 (CHFI) indexed table; this tool " +
            "converts hash-keyed formats only — regenerate with " +
            "tools/generate-tablebase.js --v3 instead");
    }
    var src = new checkers.ResultList2(buffer);
    var n = src.getStats().size;
    var entries = new Array(n);
    for (var i = 0; i < n; i++) {
        entries[i] = src.entryAt(i);
    }
    return checkers.buildTablebaseV3(entries, forcedJumps);
}

function convertFile(inPath, outPath, forcedJumps) {
    var raw = fs.readFileSync(inPath);
    var buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    var out = convertBuffer(buffer, forcedJumps);
    // Round-trip verification before writing: every logical entry identical,
    // and stats agree.
    var src = new checkers.ResultList2(buffer);
    var dst = new checkers.ResultList2(out);
    var n = src.getStats().size;
    if (dst.getStats().size !== n) {
        throw new Error("entry count mismatch after conversion");
    }
    if (dst.getStats().forcedJumps !== forcedJumps) {
        throw new Error("flags mismatch after conversion");
    }
    for (var i = 0; i < n; i++) {
        var a = src.entryAt(i), b = dst.entryAt(i);
        if (a.h0 !== b.h0 || a.h1Hi !== b.h1Hi || a.h1Lo !== b.h1Lo ||
                a.resultAndDist !== b.resultAndDist) {
            throw new Error("entry " + i + " mismatch after conversion");
        }
    }
    fs.writeFileSync(outPath, Buffer.from(out));
    return { entries: n, inBytes: raw.length, outBytes: out.byteLength };
}

if (require.main === module) {
    var args = process.argv.slice(2);
    if (args.length !== 3 || (args[2] !== 'forced' && args[2] !== 'unforced')) {
        console.error("usage: node tools/convert-tablebase.js <input> <output> forced|unforced");
        process.exit(2);
    }
    var result = convertFile(args[0], args[1], args[2] === 'forced');
    console.log("converted " + args[0] + " -> " + args[1] + ": " + result.entries +
        " entries, " + result.inBytes + " -> " + result.outBytes + " bytes (" +
        (100 * result.outBytes / result.inBytes).toFixed(1) + "%)");
}

module.exports = { convertBuffer: convertBuffer, convertFile: convertFile };
