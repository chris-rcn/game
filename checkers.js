"use strict";

var CHF = CHF || {};

if (typeof require !== 'undefined') {
    CHF.common = require('./common.js');
}

CHF.checkers = function() {
    var common = CHF.common;
    var pub = common.isNodeJs() ? exports : {};
    var fmt = common.format;
    var log = common.log;
    var assert = common.assert;
    var round = common.round;

    var boardSize = 8;  // even number
    if (boardSize !== 8) {
        log("boardSize={}", boardSize.toString());
    }

    var drawThreshold = 18; // trial and error.  7 looks correct for boardSize=4.   For boardSize=8, at least 18.

    var random = new common.Random(1);

    var halfBoardSize = boardSize / 2;
    assert(halfBoardSize * 2 === boardSize);
    var boardSizeM1 = boardSize - 1;
    var boardSizeP1 = boardSize + 1;

    var firstBoardLocation = 1;
    var lastBoardLocation = boardSize * boardSizeP1;
    var jumpsAreForced = true;

    var BLACK = 1;
    var RED = 2;
    var PAWN = BLACK | RED;
    var KING = 4;
    var OPEN = 8;

    var pieceChar = [];
    pieceChar[BLACK] = " b";
    pieceChar[RED] = " r";
    pieceChar[BLACK | KING] = " B";
    pieceChar[RED | KING] = " R";
    pieceChar[OPEN] = " .";

    var maxDiagonalOffset = boardSize + 2;
    var diagonals = [];
    diagonals[BLACK] = [ -boardSize, -maxDiagonalOffset ];
    diagonals[RED] = [ boardSize, maxDiagonalOffset ];
    diagonals[BLACK + KING] = [ -boardSize, -maxDiagonalOffset, boardSize, maxDiagonalOffset ];
    diagonals[RED + KING] = [ -boardSize, -maxDiagonalOffset, boardSize, maxDiagonalOffset ];

    var directionIndexes = [];
    directionIndexes[boardSize] = 0; // down and left
    directionIndexes[maxDiagonalOffset] = 1; // down and right
    directionIndexes[-boardSize] = 2; // up and right
    directionIndexes[-maxDiagonalOffset] = 3; // up and left
    directionIndexes[2 * boardSize] = 0; // down and left jump
    directionIndexes[2 * maxDiagonalOffset] = 1; // down and right jump
    directionIndexes[2 * -boardSize] = 2; // up and right jump
    directionIndexes[2 * -maxDiagonalOffset] = 3; // up and left jump
    var indexDirection = [boardSize, maxDiagonalOffset, -boardSize, -maxDiagonalOffset];
    pub.directionToIndex = function(offset) {
        return directionIndexes[offset];
    };
    pub.indexToDirection = function(index) {
        return indexDirection[index];
    };

    var squareIndexLookups = function () {
        var squares = new Game().getState().squares;
        var squareToIndex = [];
        var indexToSquare = [];
        var index = 0;
        for (var sq=firstBoardLocation; sq<=lastBoardLocation; sq++) {
            if (squares[sq]) {
                squareToIndex[sq] = index;
                indexToSquare[index] = sq;
                index++;
            }
        }
        return {squareToIndex:squareToIndex, indexToSquare:indexToSquare};
    }();

    pub.squareToIndex = function(sq) {
        return squareIndexLookups.squareToIndex[sq];
    };
    pub.indexToSquare = function(i) {
        return squareIndexLookups.indexToSquare[i];
    };

    function seed(s) {
        random = new common.Random(s);
    }
    pub.seed = seed;

    function getDrawThreshold() {
        return drawThreshold;
    }
    pub.getDrawThreshold = getDrawThreshold;

    function getBoardSize() {
        return boardSize;
    }
    pub.getBoardSize = getBoardSize;

    // Tablebase v3 ("CHFT"): 16-byte header — magic 'CHFT', u32 version=1,
    // u32 entryCount, u32 flags (bit0 = jumpsAreForced) — followed by
    // exact-sized arrays: u32 h0[n] | u16 (h1>>>16)[n] | u8 (h1&0xFF)[n] |
    // u8 resultAndDist[n].  All little-endian.
    var TB_MAGIC = 0x54464843; // 'C','H','F','T' little-endian
    var TB_VERSION = 1;
    var TB_HEADER_BYTES = 16;
    var TB_FLAG_FORCED = 1;

    function ResultList2(buffer, byteLength) {
        var pub = this;
        if (byteLength == null) {
            byteLength = buffer.byteLength;
        }
        var size, h0Array, resultAndDistArray, matchesH1, entryAt;
        var flags = null;
        var header = byteLength >= TB_HEADER_BYTES ? new Uint32Array(buffer, 0, 4) : null;
        if (header && header[0] === TB_MAGIC) {
            // v3 headered layout.
            if (header[1] !== TB_VERSION) {
                throw new Error(fmt("Unsupported tablebase version {}", header[1]));
            }
            size = header[2];
            flags = header[3];
            if (byteLength !== TB_HEADER_BYTES + 8*size) {
                throw new Error(fmt("Tablebase header says {} entries but file has {} bytes",
                    size, byteLength));
            }
            h0Array = new Uint32Array(buffer, TB_HEADER_BYTES, size);
            var v3HiArray = new Uint16Array(buffer, TB_HEADER_BYTES + 4*size, size);
            var v3LoArray = new Uint8Array(buffer, TB_HEADER_BYTES + 6*size, size);
            resultAndDistArray = new Uint8Array(buffer, TB_HEADER_BYTES + 7*size, size);
            matchesH1 = function (i, h1) {
                return v3HiArray[i] === ((h1 >>> 16) & 0xFFFF) && v3LoArray[i] === (h1 & 0xFF);
            };
            entryAt = function (i) {
                return { h0: h0Array[i], h1Hi: v3HiArray[i], h1Lo: v3LoArray[i],
                    resultAndDist: resultAndDistArray[i] };
            };
        } else if (byteLength % 9 === 0) {
            // Legacy layout: u32 h0 | u32 h1 | u8 resultAndDist, fully used.
            size = byteLength / 9;
            h0Array = new Uint32Array(buffer, 0, size);
            var h1Array = new Uint32Array(buffer, 4*size, size);
            resultAndDistArray = new Uint8Array(buffer, 8*size, size);
            matchesH1 = function (i, h1) {
                return h1Array[i] === h1;
            };
            entryAt = function (i) {
                return { h0: h0Array[i], h1Hi: (h1Array[i] >>> 16) & 0xFFFF,
                    h1Lo: h1Array[i] & 0xFF, resultAndDist: resultAndDistArray[i] };
            };
        } else if (byteLength % 8 === 0) {
            // Capacity-padded layout: u32 h0 | u16 (h1>>>16) | u8 (h1&0xFF) |
            // u8 resultAndDist, each array allocated for `capacity` entries;
            // the used prefix is sorted by h0 and the rest is zero-filled.
            var capacity = byteLength / 8;
            h0Array = new Uint32Array(buffer, 0, capacity);
            var h1HiArray = new Uint16Array(buffer, 4*capacity, capacity);
            var h1LoArray = new Uint8Array(buffer, 6*capacity, capacity);
            resultAndDistArray = new Uint8Array(buffer, 7*capacity, capacity);
            size = capacity;
            while (size > 0 && h0Array[size-1] === 0) {
                size--; // trailing zeros are padding (a real h0 of 0 would sort first)
            }
            matchesH1 = function (i, h1) {
                return h1HiArray[i] === ((h1 >>> 16) & 0xFFFF) && h1LoArray[i] === (h1 & 0xFF);
            };
            entryAt = function (i) {
                return { h0: h0Array[i], h1Hi: h1HiArray[i], h1Lo: h1LoArray[i],
                    resultAndDist: resultAndDistArray[i] };
            };
        } else {
            throw new Error(fmt(
                "Unrecognized tablebase format: no CHFT header and {} bytes is divisible by neither 9 (legacy) nor 8 (capacity-padded)",
                byteLength));
        }
        var maxObservedCheckerCount = 0;

        function getStats() {
            return {
                size: size,
                forcedJumps: flags === null ? null : (flags & TB_FLAG_FORCED) !== 0
            };
        }
        pub.getStats = getStats;

        pub.entryAt = function (i) {
            assert(i >= 0 && i < size, "entryAt out of range");
            return entryAt(i);
        };

        function getMaxObservedCheckerCount() {
            return maxObservedCheckerCount;
        }
        pub.getMaxObservedCheckerCount = getMaxObservedCheckerCount;

        function decode(resultAndDist) {
            var distance = resultAndDist & 63;
            var value = ((resultAndDist - distance) >> 6) - 1;
            return { v:value, d:distance };
        }

        function getEntry(hash, checkerCount) {
            assert(hash);
            if (size === 0) {
                return null;
            }
            var i = common.binarySearch(h0Array, hash.h0, size);
            if (i >= 0) {
                while (h0Array[i-1] === hash.h0) i--; // binarySearch might not return the first one.
                for (; i < size && h0Array[i] === hash.h0; i++) {
                    if (matchesH1(i, hash.h1)) {
                        if (checkerCount > maxObservedCheckerCount) {
                            maxObservedCheckerCount = checkerCount;
                        }
                        return decode(resultAndDistArray[i]);
                    }
                }
            }
            if (checkerCount < maxObservedCheckerCount) {
                return { v:0, d:0 };
            }
            return null;
        }
        pub.getEntry = getEntry;
    }
    pub.ResultList2 = ResultList2;

    // ---- v4 "CHFI" dense-indexed tablebase ----
    // Header (16 bytes): u32 magic 'CHFI' | u32 version=1 | u32 flags
    // (bit0 = jumpsAreForced) | u32 maxPieces.  Data: one byte per base
    // position (jumpContinuationLoc = 0), sections k = 2..maxPieces, each of
    // 2 * C(32,k) * 4^k slots addressed by tablebaseRank below.  Byte 255 =
    // no entry (invalid slot, or piece counts outside coverage); otherwise
    // the v3 resultAndDist encoding ((v+1)<<6 | d), so a draw is stored
    // explicitly as 64.  Mid-jump states are not stored: the search recurses
    // through the short forced continuation to the next base position.
    var TB4_MAGIC = 0x49464843; // 'C','H','F','I' little-endian
    var TB4_VERSION = 1;
    var TB4_HEADER_BYTES = 16;

    var binomial = [];
    (function () {
        for (var n = 0; n <= 32; n++) {
            binomial[n] = [];
            for (var k = 0; k <= 6; k++) {
                binomial[n][k] = (k === 0) ? 1 :
                    (n === 0) ? 0 : binomial[n-1][k-1] + binomial[n-1][k];
            }
        }
    })();

    function tb4SectionSlots(k) {
        return 2 * binomial[32][k] * Math.pow(4, k);
    }
    function tb4SectionOffset(k) {
        var offset = 0;
        for (var j = 2; j < k; j++) offset += tb4SectionSlots(j);
        return offset;
    }
    function tablebaseSlotCount(maxPieces) {
        return tb4SectionOffset(maxPieces + 1);
    }
    pub.tablebaseSlotCount = tablebaseSlotCount;

    // Dense rank of a base position (jumpContinuationLoc must be 0) within a
    // <=maxPieces table, or -1 when outside the addressable space.
    function tablebaseRank(game, maxPieces) {
        if (game.getJumpContinuationLoc() !== 0) return -1;
        var k = game.getCheckerCount();
        if (k < 2 || k > maxPieces) return -1;
        var idx = [];
        var digitOf = {};
        game.eachPiece(function (loc, piece) {
            var si = squareIndexLookups.squareToIndex[loc];
            idx.push(si);
            digitOf[si] = ((piece & RED) ? 2 : 0) + ((piece & KING) ? 1 : 0);
        });
        idx.sort(function (a, b) { return a - b; });
        var comboRank = 0, digits = 0, pow = 1;
        for (var i = 0; i < k; i++) {
            comboRank += binomial[idx[i]][i + 1];
            digits += digitOf[idx[i]] * pow;
            pow *= 4;
        }
        var turnBit = game.turnIsBlack() ? 0 : 1;
        return tb4SectionOffset(k) + (comboRank * pow + digits) * 2 + turnBit;
    }
    pub.tablebaseRank = tablebaseRank;

    function TablebaseV4(buffer, byteLength) {
        var pub = this;
        if (byteLength == null) {
            byteLength = buffer.byteLength;
        }
        var header = new Uint32Array(buffer, 0, 4);
        assert(header[0] === TB4_MAGIC, "not a CHFI tablebase");
        if (header[1] !== TB4_VERSION) {
            throw new Error(fmt("Unsupported CHFI tablebase version {}", header[1]));
        }
        var flags = header[2];
        var maxPieces = header[3];
        var slots = tablebaseSlotCount(maxPieces);
        if (byteLength !== TB4_HEADER_BYTES + slots) {
            throw new Error(fmt("CHFI header says maxPieces={} ({} slots) but file has {} data bytes",
                maxPieces, slots, byteLength - TB4_HEADER_BYTES));
        }
        var data = new Uint8Array(buffer, TB4_HEADER_BYTES, slots);
        var cachedSize = -1;

        function probe(game) {
            var rank = tablebaseRank(game, maxPieces);
            if (rank < 0) return null;
            var b = data[rank];
            if (b === 255) return null;
            var d = b & 63;
            return { v: ((b - d) >> 6) - 1, d: d };
        }
        pub.probe = probe;

        function getStats() {
            if (cachedSize < 0) {
                cachedSize = 0;
                for (var i = 0; i < slots; i++) {
                    if (data[i] !== 255 && data[i] !== 64) cachedSize++;
                }
            }
            return {
                size: cachedSize,
                maxPieces: maxPieces,
                forcedJumps: (flags & TB_FLAG_FORCED) !== 0
            };
        }
        pub.getStats = getStats;

        pub.rawData = function () { return data; };
        pub.getMaxPieces = function () { return maxPieces; };
    }
    pub.TablebaseV4 = TablebaseV4;

    function buildTablebaseV4Header(forcedJumps, maxPieces) {
        var buffer = new ArrayBuffer(TB4_HEADER_BYTES);
        var header = new Uint32Array(buffer);
        header[0] = TB4_MAGIC;
        header[1] = TB4_VERSION;
        header[2] = forcedJumps ? TB_FLAG_FORCED : 0;
        header[3] = maxPieces;
        return buffer;
    }
    pub.buildTablebaseV4Header = buildTablebaseV4Header;

    // Open a tablebase buffer of any supported format.
    function openTablebase(buffer, byteLength) {
        var len = byteLength == null ? buffer.byteLength : byteLength;
        if (len >= TB4_HEADER_BYTES && new Uint32Array(buffer, 0, 1)[0] === TB4_MAGIC) {
            return new TablebaseV4(buffer, len);
        }
        return new ResultList2(buffer, len);
    }
    pub.openTablebase = openTablebase;

    // entries: [{h0, h1Hi, h1Lo, resultAndDist}] sorted by h0 ascending.
    function buildTablebaseV3(entries, forcedJumps) {
        var n = entries.length;
        var buffer = new ArrayBuffer(TB_HEADER_BYTES + 8*n);
        var header = new Uint32Array(buffer, 0, 4);
        header[0] = TB_MAGIC;
        header[1] = TB_VERSION;
        header[2] = n;
        header[3] = forcedJumps ? TB_FLAG_FORCED : 0;
        var h0 = new Uint32Array(buffer, TB_HEADER_BYTES, n);
        var hi = new Uint16Array(buffer, TB_HEADER_BYTES + 4*n, n);
        var lo = new Uint8Array(buffer, TB_HEADER_BYTES + 6*n, n);
        var rd = new Uint8Array(buffer, TB_HEADER_BYTES + 7*n, n);
        for (var i=0; i<n; i++) {
            var e = entries[i];
            assert(i === 0 || e.h0 >= entries[i-1].h0, "entries must be sorted by h0");
            h0[i] = e.h0;
            hi[i] = e.h1Hi;
            lo[i] = e.h1Lo;
            rd[i] = e.resultAndDist;
        }
        return buffer;
    }
    pub.buildTablebaseV3 = buildTablebaseV3;

    function genZobristData(seed) {
        var rand = new common.Random(seed);
        var rands = rand.int31array(7 * (lastBoardLocation+10));
        var t=[], b =[], jc=[];
        var i = 0;
        t[BLACK] = rands[i++];
        t[RED] = rands[i++];
        for (var loc=0; loc<=lastBoardLocation; loc++) {
            var z = [];
            z[BLACK] = rands[i++];
            z[RED] = rands[i++];
            z[BLACK|KING] = rands[i++];
            z[RED|KING] = rands[i++];
            z[OPEN] = rands[i++];
            b[loc] = z;
            jc[loc] = rands[i++];
        }
        assert(i < rands.length);
        // Do this separately.  A change in drawThreshold should be fine.
        var sp = rand.int31array(drawThreshold+1);
        return { turn: t, board: b, sinceProgress: sp, jumpContinuation: jc };
    }

    var zobristData0 = genZobristData(123);
    var zobristData1 = genZobristData(345);

    function Move(from, to) {
        this.from = from;
        this.to = to;
    }

    function Game(sourceState, backdoor) {
        var pub = this;
        var turn;
        var jumpContinuationLoc;
        var squares;
        var movesSinceProgress;
        var legalMoves;
        var checkers;
        function getState() {
            //checkCheckers();
            var s = {};
            s.turn = turn;
            s.jumpContinuationLoc = jumpContinuationLoc;
            s.squares = squares.slice();
            s.movesSinceProgress = movesSinceProgress;
            s.legalMoves = legalMoves ? legalMoves.slice() : null;
            s.checkers = [];
            s.checkers[BLACK] = checkers[BLACK].slice();
            s.checkers[RED] = checkers[RED].slice();
            return s;
        }
        function setState(s) {
            if (s.checkers) {
                turn = s.turn;
                jumpContinuationLoc = s.jumpContinuationLoc;
                squares = s.squares;
                movesSinceProgress = s.movesSinceProgress;
                legalMoves = s.legalMoves;
                checkers = s.checkers;
                //checkCheckers();
            }
        }
        function swapTurnCopy() {
            var s = getState();
            s.turn = otherColor(turn);
            s.jumpContinuationLoc = 0;
            s.legalMoves = null;
            return new Game(s);
        }
        if (backdoor) {
            backdoor.setState = setState;
        }
        if (sourceState) {
            setState(sourceState);
        } else {
            reset();
            checkCheckers();
        }
        function reset() {
            turn = BLACK;
            jumpContinuationLoc = 0;
            squares = [];
            movesSinceProgress = 0;
            legalMoves = null;
            checkers = [];
            checkers[BLACK] = [];
            checkers[RED] = [];
            var offset = 1;
            var r, row = 0;
            for (r=0; r<halfBoardSize-1; r++) {
                placeRow(RED, row * boardSizeP1 + firstBoardLocation + offset);
                offset = 1 - offset;
                row++;
            }
            for (r=0; r<2; r++) {
                placeRow(OPEN, row * boardSizeP1 + firstBoardLocation + offset);
                offset = 1 - offset;
                row++;
            }
            for (r=0; r<halfBoardSize-1; r++) {
                placeRow(BLACK, row * boardSizeP1 + firstBoardLocation + offset);
                offset = 1 - offset;
                row++;
            }
        }
        pub.reset = reset;
        function copy() {
            return new Game(getState());
        }
        function placeRow(color, loc) {
            for (var column=0; column<halfBoardSize; column++) {
                addChecker(loc, color);
                loc += 2;
            }
        }
        function getCheckerCount() {
            return checkers[BLACK].length + checkers[RED].length;
        }
        function getCheckerCounts() {
            return [checkers[BLACK].length, checkers[RED].length];
        }
        pub.getCheckerCounts = getCheckerCounts;
        function toCompactString() {
            var str = "";
            var row, column;
            for (row=0; row<boardSize; row++) {
                for (column=0; column<boardSize; column++) {
                    var tileColor = (row + column) % 2;
                    if (tileColor === 1) {
                        var loc = coordToLoc(row, column);
                        str = str + pieceChar[squares[loc]].trim();
                    }
                }
            }
            return fmt(str + " ({})", pieceChar[turn].trim());
        }
        function toString() {
            var str = fmt("Turn={} jumpLoc={} hash={} checkerCount={}, materialEvalBlack={}\n",
                pieceChar[turn].trim(), jumpContinuationLoc, JSON.stringify(hash()), getCheckerCount(), round(materialEvalBlack(), 3));
            var row, column;
            for (row=0; row<boardSize; row++) {
                var line = "";
                for (column=0; column<boardSize; column++) {
                    var tileColor = (row + column) % 2;
                    if (tileColor === 1) {
                        var loc = coordToLoc(row, column);
                        line = line + pieceChar[squares[loc]];
                    } else {
                        line = line + "  ";
                    }
                }
                str = str + line + "\n";
            }
            return str;
        }
        function printBoard() {
            console.log(toString());
        }
        function hash32(z, includeMovesSinceProgress) {
            // z = { turn, board, sinceProgress, jumpContinuation }
            var h = z.turn[turn] ^ z.jumpContinuation[jumpContinuationLoc];
            if (includeMovesSinceProgress) {
                h = h ^ z.sinceProgress[Math.min(movesSinceProgress, drawThreshold)];
            }
            var i, loc, checkersColor;
            checkersColor = checkers[BLACK];
            var b = z.board;
            for (i=0; i<checkersColor.length; i++) {
                loc = checkersColor[i];
                h = h ^ b[loc][squares[loc]];
            }
            checkersColor = checkers[RED];
            for (i=0; i<checkersColor.length; i++) {
                loc = checkersColor[i];
                h = h ^ b[loc][squares[loc]];
            }
            return h;
        }
        function hash(includeMovesSinceProgress) {  // TODO: deprecate
            return {
                h0: hash32(zobristData0, includeMovesSinceProgress),
                h1: hash32(zobristData1, includeMovesSinceProgress)};
        }
        function hashBase() {
            return {
                h0: hash32(zobristData0, false),
                h1: hash32(zobristData1, false)};
        }
        pub.hashBase = hashBase;
        function hashMovesSinceProgress() {
            var msp = Math.min(movesSinceProgress, drawThreshold);
            return {
                h0: zobristData0.sinceProgress[msp],
                h1: zobristData1.sinceProgress[msp]};
        }
        pub.hashMovesSinceProgress = hashMovesSinceProgress;
        function isTurn(loc) {
            return (squares[loc] & turn) > 0;
        }
        function isKing(loc) {
            return (squares[loc] & KING) > 0;
        }
        function isBlack(loc) {
            return (squares[loc] & BLACK) > 0;
        }
        function isOpen(loc) {
            return squares[loc] === OPEN;
        }
        function endTurn() {
            jumpContinuationLoc = 0;
            turn = otherColor(turn);
            legalMoves = null;
        }
        function checkCheckers() {
            var i, loc, checkersColor;
            checkersColor = checkers[BLACK];
            for (i=0; i<checkersColor.length; i++) {
                loc = checkersColor[i];
                assert((squares[loc] & BLACK));
            }
            checkersColor = checkers[RED];
            for (i=0; i<checkersColor.length; i++) {
                loc = checkersColor[i];
                assert((squares[loc] & RED));
            }
        }
        function addChecker(loc, piece) {
            squares[loc] = piece;
            if (piece !== OPEN) {
                checkers[piece & PAWN].push(loc);
            }
        }
        function removeChecker(loc) {
            var color = (squares[loc] & PAWN);
            var checkersColor = checkers[color];
            var pos = checkersColor.indexOf(loc);
            assert(pos >= 0);
            squares[loc] = OPEN;
            var last = checkersColor.pop();
            if (pos < checkersColor.length) {
                checkersColor[pos] = last;
            }
            //checkCheckers();
        }
        function moveChecker(from, to) {
            var color = (squares[from] & PAWN);
            var checkersColor = checkers[color];
            var pos = checkersColor.indexOf(from);
            assert(pos >= 0);
            squares[to] = squares[from];
            squares[from] = OPEN;
            checkersColor[pos] = to;
            //checkCheckers();
        }
        function makeMove(move, skipChecks) {
            var from = move.from;
            var to = move.to;
            if (!skipChecks) {
                if ((squares[from] & turn) === 0) return false;
                if (to % 2 === 1) return false;
                if (squares[to] !== OPEN) return false;
            }
            var startCoord = locToCoord(from);
            var endCoord = locToCoord(to);
            var rowDelta = endCoord.row - startCoord.row;
            var colDelta = endCoord.column - startCoord.column;
            var isForward = (turn === BLACK) === (rowDelta < 0);
            var king = (squares[from] & KING);
            if (!isForward && !king) return false;
            var turnIsEnding = false;
            var undo;
            var initialMovesSinceProgress = movesSinceProgress;
            var initialJumpContinuationLoc = jumpContinuationLoc;
            var initialLegalMoves = legalMoves;
            var initialTurn = turn;
            var becameKing = false;
            var kingRow = (turn === BLACK) ? 0 : boardSizeM1;
            if (Math.abs(rowDelta) === 1 && Math.abs(colDelta) === 1) {
                // slide
                if (jumpContinuationLoc) return false;
                if (jumpsAreForced && !skipChecks && hasAnyJump()) return false;
                moveChecker(from, to);
                movesSinceProgress++;
                if (!king && isForward) {
                    movesSinceProgress = 0;
                }
                if (!king && endCoord.row === kingRow) {
                    squares[to] |= KING;
                    becameKing = true;
                    turnIsEnding = true;
                }
                undo = function() {
                    moveChecker(to, from);
                    turn = initialTurn;
                    movesSinceProgress = initialMovesSinceProgress;
                    jumpContinuationLoc = initialJumpContinuationLoc;
                    legalMoves = initialLegalMoves;
                    if (becameKing) {
                        squares[from] = turn;
                    }
                };
                turnIsEnding = true;
            } else if (Math.abs(rowDelta) === 2 && Math.abs(colDelta) === 2) {
                // jump
                if (jumpContinuationLoc && jumpContinuationLoc !== from) return false;
                var opponent = otherColor(turn);
                var capturedLoc = (from + to) / 2;
                if ((squares[capturedLoc] & opponent) === 0) return false;
                var capturedPiece = squares[capturedLoc];
                moveChecker(from, to);
                removeChecker(capturedLoc);
                jumpContinuationLoc = to;
                movesSinceProgress = 0;
                if (!king && endCoord.row === kingRow) {
                    squares[to] |= KING;
                    becameKing = true;
                    turnIsEnding = true;
                }
                undo = function() {
                    moveChecker(to, from);
                    addChecker(capturedLoc, capturedPiece);
                    turn = initialTurn;
                    movesSinceProgress = initialMovesSinceProgress;
                    jumpContinuationLoc = initialJumpContinuationLoc;
                    legalMoves = initialLegalMoves;
                    if (becameKing) {
                        squares[from] = turn;
                    }
                };
            } else {
                return false;
            }
            legalMoves = null;
            if (turnIsEnding) {
                endTurn();
            } else if (jumpContinuationLoc) {
                legalMoves = getJumpMoves();
                if (legalMoves.length === 0) {
                    endTurn();
                }
            }
            return undo;
        }
        pub.makeMove = makeMove;
        function getJumpContinuationLoc() {
            return jumpContinuationLoc;
        }
        function hasJump(loc) {
            if (jumpContinuationLoc && jumpContinuationLoc !== loc) return false;
            var opponent = otherColor(turn);
            var diags = diagonals[squares[loc]];
            for (var i=0; i<diags.length; i++) {
                var diagonal = diags[i];
                var to = loc + diagonal;
                if ((squares[to] & opponent)) {
                    // there is a diagonal opponent
                    to += diagonal;
                    if (squares[to] === OPEN) {
                        return true;
                    }
                }
            }
            return false;
        }
        function hasAnyJump() {
            if (jumpContinuationLoc) {
                return hasJump(jumpContinuationLoc);
            }
            var checkersColor = checkers[turn];
            for (var i=0; i<checkersColor.length; i++) {
                if (hasJump(checkersColor[i])) {
                    return true;
                }
            }
            return false;
        }
        function hasSlide(loc) {
            var diags = diagonals[squares[loc]];
            for (var i=0; i<diags.length; i++) {
                var diagonal = diags[i];
                var to = loc + diagonal;
                if (squares[to] === OPEN) {
                    return true;
                }
            }
            return false;
        }
        function addSlideMoves(moves) {
            var checkersColor = checkers[turn];
            for (var i=0; i<checkersColor.length; i++) {
                var loc = checkersColor[i];
                var diags = diagonals[squares[loc]];
                for (var d=0; d<diags.length; d++) {
                    var diagonal = diags[d];
                    var to = loc + diagonal;
                    if (squares[to] === OPEN) {
                        var move = new Move(loc, to);
                        moves.push(move);
                    }
                }
            }
        }
        function addJumpMoves(moves, loc) {
            var opponent = otherColor(turn);
            var diags = diagonals[squares[loc]];
            for (var d=0; d<diags.length; d++) {
                var diagonal = diags[d];
                var capture = loc + diagonal;
                if ((squares[capture] & opponent)) {
                    // there is a diagonal opponent
                    var to = capture + diagonal;
                    if (squares[to] === OPEN) {
                        var move = new Move(loc, to);
                        moves.push(move);
                    }
                }
            }
        }
        function getJumpMoves() {
            var moves = [];
            if (jumpContinuationLoc) {
                addJumpMoves(moves, jumpContinuationLoc);
                return moves;
            }
            var checkersColor = checkers[turn];
            for (var i=0; i<checkersColor.length; i++) {
                addJumpMoves(moves, checkersColor[i]);
            }
            return moves;
        }
        function calcMoves() {
            if (checkers[BLACK].length === 0 || checkers[RED].length === 0) {
                return [];
            }
            var moves = getJumpMoves();
            if (jumpContinuationLoc) {
                return moves;
            }
            if (moves.length > 0 && jumpsAreForced) {
                return moves;
            }
            addSlideMoves(moves);
            return moves;
        }
        function getMoves() {
            if (legalMoves === null) {
                legalMoves = calcMoves();
            }
            return legalMoves.slice();
        }
        function checkerCanMove(loc) {
            if (jumpContinuationLoc && jumpContinuationLoc !== loc) {
                return false;
            }
            if (hasJump(loc)) {
                return true;
            }
            if (jumpsAreForced && hasAnyJump()) {
                return false;
            }
            return hasSlide(loc);
        }
        function rank(loc) {
            return Math.floor((loc-1) / boardSizeP1);
        }
        function forwardRank(loc, color) {
            return (color & RED) ? rank(loc) : boardSizeM1-rank(loc);
        }
        pub.forwardRank = forwardRank;
        function materialEval(kingWeight, rankWeight, homeRowBonus, supportBonus, homeRowFullSupport, kingCenterBonus, runawayBonus, runawayGraded) {
            var polarity = turn === BLACK ? 1 : -1;
            return polarity * (2 * materialEvalBlack(kingWeight, rankWeight, homeRowBonus, supportBonus, homeRowFullSupport, kingCenterBonus, runawayBonus, runawayGraded) - 1);
        }
        // Steps from the nearest board edge: 0 (on an edge) .. 3 (the four
        // center squares).  An edge king has at most half a center king's
        // moves and is the piece that gets trapped in corners; the cost of
        // bad king placement cashes in too slowly for the search horizon.
        function edgeDistance(loc) {
            var row = rank(loc);
            var col = (loc - 1) % boardSizeP1;
            var dr = row < boardSizeM1 - row ? row : boardSizeM1 - row;
            var dc = col < boardSizeM1 - col ? col : boardSizeM1 - col;
            return dr < dc ? dr : dc;
        }
        // A pawn is a RUNAWAY when no enemy piece stands anywhere in its
        // forward cone — the set of squares any path to the kinging row can
        // pass through.  This is a snapshot approximation (enemies can step
        // into the cone later, and kings can chase from behind), but it is
        // exactly the future the search horizon cannot see: an uncontested
        // coronation several plies out.
        function pawnIsRunaway(loc, color) {
            var row = rank(loc);
            var col = (loc - 1) % boardSizeP1;
            var enemy = (color & RED) ? BLACK : RED;
            var dir = (color & RED) ? 1 : -1;
            var steps = (color & RED) ? boardSizeM1 - row : row;
            for (var k = 1; k <= steps; k++) {
                var rr = row + dir * k;
                var c = col - k < 0 ? 0 : col - k;
                if (((rr + c) & 1) === 0) c++; // playable squares have odd row+col
                var cEnd = col + k > boardSizeM1 ? boardSizeM1 : col + k;
                var sq = rr * boardSizeP1 + c + 1;
                for (; c <= cEnd; c += 2, sq += 2) {
                    if ((squares[sq] & enemy)) return false;
                }
            }
            return true;
        }
        // A pawn counts 1 + rankWeight * forwardRank (its progress toward
        // kinging) + homeRowBonus if it still guards the back row; folding
        // these into the material ratio keeps them phase-scaled the same way
        // material itself is.  The back-row bonus prices kinging PREVENTION,
        // so it applies only while the opponent still has pawns to king —
        // against a kings-only opponent, staying home is worthless.
        // supportBonus is awarded per friendly piece diagonally BEHIND a pawn
        // (0, 1 or 2): a supporter occupies the square a jumper would land
        // on, so support measures un-capturability from the front.  A back-
        // row pawn has no behind squares; homeRowFullSupport decides whether
        // that counts as fully supported (it is literally unjumpable) or as
        // nothing (its safety is already priced by homeRowBonus).
        // kingCenterBonus is awarded per edge-distance step (0..3) of each
        // king, pricing centralization; runawayBonus is awarded to each
        // runaway pawn (see pawnIsRunaway), pricing a coronation beyond the
        // horizon at a discount to the kinged difference (kingWeight - 1).
        // runawayGraded scales that bonus by forwardRank/6 — a runaway one
        // step from kinging collects the full bonus, one far from it almost
        // nothing, matching how certain the coronation actually is.
        function materialEvalBlack(kingWeight, rankWeight, homeRowBonus, supportBonus, homeRowFullSupport, kingCenterBonus, runawayBonus, runawayGraded) {
            kingWeight = kingWeight || 2;
            rankWeight = rankWeight || 0;
            homeRowBonus = homeRowBonus || 0;
            supportBonus = supportBonus || 0;
            kingCenterBonus = kingCenterBonus || 0;
            runawayBonus = runawayBonus || 0;
            var black = 0;
            var red = 0;
            var blackPawns = 0, redPawns = 0, blackHome = 0, redHome = 0;
            var i, loc, fr, checkersColor;
            checkersColor = checkers[BLACK];
            for (i=0; i<checkersColor.length; i++) {
                loc = checkersColor[i];
                if ((squares[loc] & KING)) {
                    black += kingWeight;
                    if (kingCenterBonus) black += kingCenterBonus * edgeDistance(loc);
                } else {
                    blackPawns++;
                    fr = forwardRank(loc, BLACK);
                    black += 1 + rankWeight * fr;
                    if (fr === 0) {
                        blackHome++;
                        if (homeRowFullSupport) black += 2 * supportBonus;
                    } else if (supportBonus) {
                        if ((squares[loc + boardSize] & BLACK)) black += supportBonus;
                        if ((squares[loc + maxDiagonalOffset] & BLACK)) black += supportBonus;
                    }
                    if (runawayBonus && pawnIsRunaway(loc, BLACK)) {
                        black += runawayGraded ? runawayBonus * fr / 6 : runawayBonus;
                    }
                }
            }
            checkersColor = checkers[RED];
            for (i=0; i<checkersColor.length; i++) {
                loc = checkersColor[i];
                if ((squares[loc] & KING)) {
                    red += kingWeight;
                    if (kingCenterBonus) red += kingCenterBonus * edgeDistance(loc);
                } else {
                    redPawns++;
                    fr = forwardRank(loc, RED);
                    red += 1 + rankWeight * fr;
                    if (fr === 0) {
                        redHome++;
                        if (homeRowFullSupport) red += 2 * supportBonus;
                    } else if (supportBonus) {
                        if ((squares[loc - boardSize] & RED)) red += supportBonus;
                        if ((squares[loc - maxDiagonalOffset] & RED)) red += supportBonus;
                    }
                    if (runawayBonus && pawnIsRunaway(loc, RED)) {
                        red += runawayGraded ? runawayBonus * fr / 6 : runawayBonus;
                    }
                }
            }
            if (redPawns > 0) black += homeRowBonus * blackHome;
            if (blackPawns > 0) red += homeRowBonus * redHome;
            return black / (black + red);
        }

        function getMovesSinceProgress() {
            return movesSinceProgress;
        }
        pub.getMovesSinceProgress = getMovesSinceProgress;

        function turnIsBlack() {
            return turn === BLACK;
        }
        pub.turnIsBlack = turnIsBlack;

        function eachPiece(cb) {
            var i, checkersColor;
            checkersColor = checkers[BLACK];
            for (i=0; i<checkersColor.length; i++) {
                cb(checkersColor[i], squares[checkersColor[i]]);
            }
            checkersColor = checkers[RED];
            for (i=0; i<checkersColor.length; i++) {
                cb(checkersColor[i], squares[checkersColor[i]]);
            }
        }
        pub.eachPiece = eachPiece;

        pub.makeMove = makeMove;
        pub.isBlack = isBlack;
        pub.isOpen = isOpen;
        pub.isKing = isKing;
        pub.getJumpContinuationLoc = getJumpContinuationLoc;
        pub.copy = copy;
        pub.checkerCanMove = checkerCanMove;
        pub.hasAnyJump = hasAnyJump;
        pub.materialEvalBlack = materialEvalBlack;
        pub.materialEval = materialEval;
        pub.getMoves = getMoves;
        pub.getJumpMoves = getJumpMoves;
        pub.printBoard = printBoard;
        pub.hash = hash;
        pub.getCheckerCount = getCheckerCount;
        pub.getState = getState;
        pub.isTurn = isTurn;
        pub.swapTurnCopy = swapTurnCopy;
        pub.toString = toString;
        pub.toCompactString = toCompactString;
    }

    function otherColor(color) {
        return BLACK + RED - color;
    }
    function locToCoord(loc) {
        var loc0 = loc - firstBoardLocation;
        return {
            row: Math.floor(loc0 / boardSizeP1),
            column: loc0 % boardSizeP1
        };
    }
    function coordToLoc(row, column) {
        return row * boardSizeP1 + column + firstBoardLocation;
    }

    function setForcedJumps(value) {
        jumpsAreForced = value;
    }
    pub.setForcedJumps = setForcedJumps;
    function getForcedJumps() {
        return jumpsAreForced;
    }
    pub.getForcedJumps = getForcedJumps;

    function isJump(move) {
        return Math.abs(move.to - move.from) > maxDiagonalOffset;
    }
    pub.isJump = isJump;

    pub.Game = Game;
    pub.Move = Move;
    pub.locToCoord = locToCoord;
    pub.coordToLoc = coordToLoc;
    pub.otherColor = otherColor;
    return pub;
}();
