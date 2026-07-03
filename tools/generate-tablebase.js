"use strict";
// Endgame tablebase generator: solves all positions with up to `maxPieces`
// pieces by layered retrograde analysis, using the engine itself for move
// generation and transitions (rule fidelity is inherited, not reimplemented).
//
// Semantics (matching the engine and the shipped tables):
// - A state is (board, side to move, jumpContinuationLoc). Mid-jump states
//   (continuation pending) are distinct states, enumerated wherever the
//   piece on jumpContinuationLoc has a capture available.
// - The side to move with no legal moves has lost: v = -1, d = 0.
// - Values are from the side to move's perspective. A move to a child keeps
//   the mover's perspective when the turn continues (multi-jump) and negates
//   it when the turn passes.
// - Wins take the fastest path (d = 1 + min losing-child d), losses the
//   slowest (d = 1 + max winning-child d). States never labeled after
//   convergence are draws under optimal play and are not stored — the
//   clockless draw semantics the shipped tables use.

var path = require('path');
var fs = require('fs');
var checkers = require(path.join(__dirname, '..', 'checkers.js'));

var BLACK = 1, RED = 2, PAWN = 3, KING = 4, OPEN = 8;

var darkSquares = [];
(function () {
    for (var r = 0; r < 8; r++) {
        for (var c = 0; c < 8; c++) {
            if ((r + c) % 2 === 1) darkSquares.push(r * 9 + c + 1);
        }
    }
})();

function rowOf(loc) { return Math.floor((loc - 1) / 9); }

// Legal piece states for a square: pawns may not sit on their kinging row.
function pieceStatesFor(loc) {
    var row = rowOf(loc);
    var states = [BLACK | KING, RED | KING];
    if (row !== 0) states.push(BLACK);
    if (row !== 7) states.push(RED);
    return states;
}

function makeGame(placements, turn, jumpLoc) {
    var squares = [], lists = [];
    lists[BLACK] = [];
    lists[RED] = [];
    darkSquares.forEach(function (l) { squares[l] = OPEN; });
    placements.forEach(function (p) {
        squares[p[0]] = p[1];
        lists[p[1] & PAWN].push(p[0]);
    });
    return new checkers.Game({
        turn: turn, jumpContinuationLoc: jumpLoc || 0, squares: squares,
        movesSinceProgress: 0, legalMoves: null, checkers: lists
    });
}

function stateKeyOf(game) {
    return game.toCompactString() + "|" + game.getJumpContinuationLoc();
}

// Enumerate every state with 2..maxPieces pieces (both colors present),
// both turns, including mid-jump continuation states. Calls
// onState(game, turn, jumpLoc) for each; may visit a state key repeatedly
// only via different construction paths, so callers dedupe by key.
function enumerateStates(maxPieces, onState) {
    var placements = [];
    function emit() {
        var colors = 0;
        for (var i = 0; i < placements.length; i++) colors |= (placements[i][1] & PAWN);
        if (colors !== PAWN) {
            // Single-color board: the other side has been eliminated and is
            // to move with no pieces — a terminal loss reachable as the
            // state after a final capture. The winner can hold at most
            // maxPieces-1 pieces in a game confined to this space.
            if (placements.length <= maxPieces - 1) {
                var mover = colors === BLACK ? RED : BLACK;
                onState(makeGame(placements, mover, 0), mover, 0);
            }
            return;
        }
        [BLACK, RED].forEach(function (turn) {
            onState(makeGame(placements, turn, 0), turn, 0);
            for (var i = 0; i < placements.length; i++) {
                var p = placements[i];
                if ((p[1] & PAWN) !== turn) continue;
                var g = makeGame(placements, turn, p[0]);
                var moves = g.getMoves();
                if (moves.length > 0 && checkers.isJump(moves[0])) {
                    onState(g, turn, p[0]);
                }
            }
        });
    }
    function recurse(count, startIdx) {
        if (count === 0) { emit(); return; }
        for (var i = startIdx; i < darkSquares.length; i++) {
            var states = pieceStatesFor(darkSquares[i]);
            for (var s = 0; s < states.length; s++) {
                placements.push([darkSquares[i], states[s]]);
                recurse(count - 1, i + 1);
                placements.pop();
            }
        }
    }
    for (var n = 1; n <= maxPieces; n++) recurse(n, 0);
}

// Solve the state space. Returns { entries: Map stateKey -> {v,d,h0,h1},
// totalStates, rounds }.
function solve(maxPieces, forcedJumps, log) {
    log = log || function () {};
    var restoreForced = checkers.getForcedJumps();
    checkers.setForcedJumps(forcedJumps);

    // Pass 1: index states.
    var index = new Map();
    var keys = [];
    var hashes = [];
    enumerateStates(maxPieces, function (game) {
        var key = stateKeyOf(game);
        if (index.has(key)) return;
        index.set(key, keys.length);
        keys.push(key);
        hashes.push(game.hashBase());
    });
    var n = keys.length;
    log("states: " + n);

    // Pass 2: edges via the engine. Child id -1 means "opponent eliminated"
    // (a loss-for-child-mover terminal outside the enumerated space).
    var edgeLists = new Array(n);
    enumerateStates(maxPieces, function (game) {
        var id = index.get(stateKeyOf(game));
        if (edgeLists[id]) return;
        var moves = game.getMoves();
        var edges = [];
        var wasBlack = game.turnIsBlack();
        for (var m = 0; m < moves.length; m++) {
            var undo = game.makeMove(moves[m], true);
            var childKey = stateKeyOf(game);
            edges.push([
                index.has(childKey) ? index.get(childKey) : -1,
                game.turnIsBlack() === wasBlack ? 1 : 0
            ]);
            undo();
        }
        edgeLists[id] = edges;
    });
    checkers.setForcedJumps(restoreForced);

    // Layered retrograde: round k labels exactly the states with d = k.
    var V = new Int8Array(n);
    var D = new Int32Array(n);
    var labeled = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
        if (edgeLists[i].length === 0) { V[i] = -1; D[i] = 0; labeled[i] = 1; }
    }
    var round = 0;
    var progressed = true;
    while (progressed) {
        round++;
        progressed = false;
        for (var s = 0; s < n; s++) {
            if (labeled[s]) continue;
            var edges = edgeLists[s];
            var minWinVia = -1;      // min d over children that are mover-wins
            var allLosing = true;
            var maxLossVia = -1;     // max d over children when all are mover-losses
            for (var e = 0; e < edges.length; e++) {
                var cid = edges[e][0];
                var cv, cd;
                if (cid === -1) { cv = -1; cd = 0; }
                else if (!labeled[cid]) { allLosing = false; continue; }
                else { cv = V[cid]; cd = D[cid]; }
                var moverView = edges[e][1] ? cv : -cv;
                if (moverView === 1) {
                    allLosing = false;
                    if (minWinVia === -1 || cd < minWinVia) minWinVia = cd;
                } else if (moverView === -1) {
                    if (cd > maxLossVia) maxLossVia = cd;
                } else {
                    allLosing = false; // a drawing move exists
                }
            }
            if (minWinVia !== -1 && minWinVia === round - 1) {
                V[s] = 1; D[s] = round; labeled[s] = 1; progressed = true;
            } else if (allLosing && maxLossVia === round - 1) {
                V[s] = -1; D[s] = round; labeled[s] = 1; progressed = true;
            }
        }
    }

    var entries = new Map();
    var wins = 0, losses = 0;
    for (var k = 0; k < n; k++) {
        if (!labeled[k]) continue;
        if (V[k] === 1) wins++; else losses++;
        entries.set(keys[k], { v: V[k], d: D[k], h0: hashes[k].h0, h1: hashes[k].h1 });
    }
    log("decisive: " + entries.size + " (wins " + wins + ", losses " + losses +
        ", draws " + (n - entries.size) + ", rounds " + round + ")");
    return { entries: entries, totalStates: n, rounds: round };
}

function writeV3(solved, forcedJumps, outPath) {
    var list = [];
    solved.entries.forEach(function (e) {
        list.push({ h0: e.h0, h1Hi: (e.h1 >>> 16) & 0xFFFF, h1Lo: e.h1 & 0xFF,
            resultAndDist: ((e.v + 1) << 6) | Math.min(e.d, 63) });
    });
    list.sort(function (a, b) { return a.h0 - b.h0 || a.h1Hi - b.h1Hi || a.h1Lo - b.h1Lo; });
    fs.writeFileSync(outPath, Buffer.from(checkers.buildTablebaseV3(list, forcedJumps)));
    return list.length;
}

if (require.main === module) {
    var args = process.argv.slice(2);
    if (args.length !== 3 || (args[1] !== 'forced' && args[1] !== 'unforced')) {
        console.error("usage: node tools/generate-tablebase.js <maxPieces> forced|unforced <out>");
        process.exit(2);
    }
    var t0 = Date.now();
    var solved = solve(parseInt(args[0], 10), args[1] === 'forced', function (m) { console.log(m); });
    var count = writeV3(solved, args[1] === 'forced', args[2]);
    console.log("wrote " + count + " entries to " + args[2] +
        " in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
}

module.exports = { solve: solve, writeV3: writeV3, enumerateStates: enumerateStates, makeGame: makeGame };
