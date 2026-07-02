"use strict";
// Shared helpers for building checkers positions in tests.
//
// Board geometry (boardSize=8): squares are numbered loc = row*9 + col + 1,
// i.e. rows have a stride of 9 so that off-board diagonal steps land on a
// phantom column and read as undefined. Playable (dark) squares are the ones
// where (row+col) is odd:
//
//   row 0:   2   4   6   8      (RED home row; RED moves DOWN, +row)
//   row 1: 10  12  14  16
//   row 2:  20  22  24  26
//   row 3: 28  30  32  34
//   row 4:  38  40  42  44
//   row 5: 46  48  50  52
//   row 6:  56  58  60  62
//   row 7: 64  66  68  70       (BLACK home row; BLACK moves UP, -row)

var checkers = require('../checkers.js');

// These constants mirror the (unexported) values inside checkers.js.
var BLACK = 1;
var RED = 2;
var PAWN = 3;
var KING = 4;
var OPEN = 8;

var PIECE_CODES = { b: BLACK, r: RED, B: BLACK | KING, R: RED | KING };

function darkSquares() {
    var locs = [];
    for (var row = 0; row < 8; row++) {
        for (var col = 0; col < 8; col++) {
            if ((row + col) % 2 === 1) {
                locs.push(checkers.coordToLoc(row, col));
            }
        }
    }
    return locs;
}

// makeGame({turn: 'black'|'red', pieces: {loc: 'b'|'r'|'B'|'R'},
//           movesSinceProgress, jumpContinuationLoc})
function makeGame(opts) {
    var squares = [];
    var lists = [];
    lists[BLACK] = [];
    lists[RED] = [];
    darkSquares().forEach(function (loc) { squares[loc] = OPEN; });
    Object.keys(opts.pieces || {}).forEach(function (key) {
        var loc = parseInt(key, 10);
        var piece = PIECE_CODES[opts.pieces[key]];
        if (!piece) throw new Error("bad piece code: " + opts.pieces[key]);
        if (squares[loc] !== OPEN) throw new Error("loc " + loc + " is not a playable square");
        squares[loc] = piece;
        lists[piece & PAWN].push(loc);
    });
    return new checkers.Game({
        turn: opts.turn === 'red' ? RED : BLACK,
        jumpContinuationLoc: opts.jumpContinuationLoc || 0,
        squares: squares,
        movesSinceProgress: opts.movesSinceProgress || 0,
        legalMoves: null,
        checkers: lists
    });
}

// Parse the 32-character board portion of Game.toCompactString(),
// e.g. fromCompact("..rr...r...bbB.r........b.bbbbbb", "r").
function fromCompact(compact, turnChar) {
    var pieces = {};
    for (var i = 0; i < 32; i++) {
        if (compact[i] !== '.') {
            pieces[checkers.indexToSquare(i)] = compact[i];
        }
    }
    return makeGame({ turn: turnChar === 'r' ? 'red' : 'black', pieces: pieces });
}

function moveSet(game) {
    return game.getMoves().map(function (m) { return m.from + '>' + m.to; }).sort();
}

// Verifies the internal checkers[] piece lists agree with the squares array.
function assertListsConsistent(game) {
    var s = game.getState();
    [BLACK, RED].forEach(function (color) {
        s.checkers[color].forEach(function (loc) {
            if ((s.squares[loc] & color) === 0) {
                throw new Error("piece list claims " + loc + " but squares[" + loc + "]=" + s.squares[loc]);
            }
        });
        var count = 0;
        for (var loc = 1; loc <= 72; loc++) {
            if (s.squares[loc] !== OPEN && (s.squares[loc] & color)) count++;
        }
        if (count !== s.checkers[color].length) {
            throw new Error("piece list length " + s.checkers[color].length +
                " but board has " + count + " pieces of color " + color);
        }
    });
}

module.exports = {
    BLACK: BLACK, RED: RED, PAWN: PAWN, KING: KING, OPEN: OPEN,
    darkSquares: darkSquares,
    makeGame: makeGame,
    fromCompact: fromCompact,
    moveSet: moveSet,
    assertListsConsistent: assertListsConsistent
};
