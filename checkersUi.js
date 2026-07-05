"use strict";

CHF.checkers.ui = function() {
    var pub = {};
    var common = CHF.common;
    var log = common.log;
    var checkers = CHF.checkers;
    var players = CHF.checkers.players;
    var coordToLoc = checkers.coordToLoc;
    var locToCoord = checkers.locToCoord;
    var boardSize = checkers.getBoardSize();

    checkers.seed();

    var board, boardCtx, boardImage, message, level;
    var game;
    var selectedLocation = null;
    var isDirty = true;
    var gameHistory = [];
    var showAnimations = true;
    var animatingMove;
    var animatingProgress;
    // Time-based animation on requestAnimationFrame: progress is computed
    // from elapsed wall time, so the slide lasts exactly animationPeriodMs
    // and every displayed frame advances proportionally (vsync-aligned).
    // Both timer-driven variants misbehaved: a fast setInterval aliased
    // against the display refresh (uneven steps, finished early under
    // timer clamping) and a literal-20fps reading was visibly chunky.
    var animationPeriodMs = 300;
    var animatingStartMs = null;
    var randPlayer = new players.Random();
    var player = new players.Search(1);
    var ignoreButtons = false;
    var computerPlaysRed = true;
    var computerPlaysBlack = false;
    var renderCoordinates = false;
    var doComputerMoveTimer;

    function devMode() {
        loadTablebase("pub", true);
        loadTablebase("pub", false);
        checkers.seed(1);
        player.logDepth = 1;
        showAnimations = false;
        renderCoordinates = true;
        computerPlaysRed = false;
        isDirty = true;
        drawBoard(game);
    }
    pub.devMode = devMode;

    function setMessage(value) {
        message.innerHTML = value;
    }
    function setSelectedLocation(loc) {
        if (loc !== selectedLocation) {
            selectedLocation = loc;
            isDirty = true;
        }
    }
    function drawChecker(loc, x, y, size) {
        var halfSize = size / 2;
        boardCtx.beginPath();
        boardCtx.arc(x + halfSize, y + halfSize, halfSize-4, 0, 2*Math.PI);
        boardCtx.fillStyle = game.isBlack(loc) ? "#333333" : "red";
        boardCtx.fill();
        boardCtx.lineWidth = 1;
        boardCtx.strokeStyle = "black";
        boardCtx.stroke();
        if (game.isKing(loc)) {
            boardCtx.beginPath();
            boardCtx.arc(x + halfSize, y + halfSize, halfSize-6, 0, 2*Math.PI);
            boardCtx.lineWidth = 2;
            boardCtx.strokeStyle = "white";
            boardCtx.stroke();
        }
    }
    function drawBoard(game) {
        syncBackingStore();
        if (!isDirty) return;
        isDirty = false;
        var pad = 2;
        var size = board.clientWidth - 2 * pad;
        var tileSize = size / boardSize;
        var row, column;
        var x, y;
        if (boardSize === 8) {
            boardCtx.drawImage(boardImage, 0, 0, board.clientWidth, board.clientWidth);
        } else {
            for (row=0; row<boardSize; row++) {
                for (column=0; column<boardSize; column++) {
                    var loc = coordToLoc(row, column);
                    x = column * tileSize + pad;
                    y = row * tileSize + pad;
                    var tileColor = (row + column) % 2;
                    boardCtx.fillStyle = (tileColor === 1) ? "chocolate" : "cornsilk";
                    boardCtx.fillRect(x, y, tileSize, tileSize);
                }
            }
        }
        var animatingMoveSource = animatingMove ? animatingMove.from : null;
        for (row=0; row<boardSize; row++) {
            for (column=0; column<boardSize; column++) {
                var loc = coordToLoc(row, column);
                x = column * tileSize + pad;
                y = row * tileSize + pad;
                var tileColor = (row + column) % 2;
                if (tileColor === 1) {
                    if (!game.isOpen(loc) && loc !== animatingMoveSource) {
                        drawChecker(loc, x, y, tileSize);
                    }
                }
            }
        }
        if (selectedLocation !== null) {
            var coord = locToCoord(selectedLocation);
            x = coord.column * tileSize + pad;
            y = coord.row * tileSize + pad;
            boardCtx.strokeStyle = "blue";
            boardCtx.lineWidth = 2;
            boardCtx.strokeRect(x, y, tileSize-1, tileSize-1);
        }
        if (animatingMove) {
            var startCoord = locToCoord(animatingMove.from);
            var endCoord = locToCoord(animatingMove.to);
            var rowDelta = endCoord.row - startCoord.row;
            var colDelta = endCoord.column - startCoord.column;
            x = startCoord.column * tileSize + pad;
            y = startCoord.row * tileSize + pad;
            var pixels = tileSize * animatingProgress;
            drawChecker(animatingMove.from, x + pixels * colDelta, y + pixels * rowDelta, tileSize);
        }
        if (renderCoordinates) {
            for (row=0; row<boardSize; row++) {
                for (column=0; column<boardSize; column++) {
                    loc = coordToLoc(row, column);
                    x = column * tileSize + pad;
                    y = row * tileSize + pad;
                    tileColor = (row + column) % 2;
                    if (tileColor === 1) {
                        boardCtx.lineWidth = 1;
                        boardCtx.strokeStyle = "orange";
                        boardCtx.font="14px Verdana";
                        boardCtx.strokeText(loc, x + tileSize/2 - 7, y + tileSize/2 + 4);
                    }
                }
            }
        }
        //log(game.hash());
    }
    function animate(nowMs) {
        if (!animatingMove) {
            animatingProgress = null;
            return;
        }
        if (animatingStartMs === null) {
            animatingStartMs = nowMs;
        }
        animatingProgress = (nowMs - animatingStartMs) / animationPeriodMs;
        isDirty = true;
        if (animatingProgress >= 1) {
            var move = animatingMove;
            animatingMove = null;
            common.assert(makeMove(move)); // may start the next segment's animation
        } else {
            window.requestAnimationFrame(animate);
        }
        drawBoard(game);
    }
    function animateMove(move) {
        animatingProgress = 0;
        animatingStartMs = null;
        animatingMove = move;
        ignoreButtons = true;
        window.requestAnimationFrame(animate);
    }
    function tapOrClick(event) {
        if (ignoreButtons) {
            return;
        }
        var rect = board.getBoundingClientRect();
        var tileSize = rect.width / boardSize;
        var point = event.touches ? event.touches[0] : event;
        var row = Math.floor((point.clientY - rect.top) / tileSize);
        var column = Math.floor((point.clientX - rect.left) / tileSize);
        var loc = coordToLoc(row, column);
        var tileColor = (row + column) % 2;
        if (tileColor === 1) {
            // black square
            if (!game.isOpen(loc)) {
                if (game.isTurn(loc)) {
                    if (game.checkerCanMove(loc)) {
                        setSelectedLocation(loc);
                    }
                }
            } else if (selectedLocation) {
                makeMove(new checkers.Move(selectedLocation, loc));
            }
        }
        drawBoard(game);
        event.preventDefault();
        return false;
    }
    // Keep the canvas backing store matched to its CSS size times the
    // device pixel ratio — crisp on high-DPI screens, resizes with the
    // viewport. Checked on EVERY draw, not just window resize events:
    // mobile layout settles after init (browser chrome, viewport units),
    // and a stale backing store crops the right/bottom board edge.
    function syncBackingStore() {
        var cssSize = board.clientWidth || 350;
        var dpr = window.devicePixelRatio || 1;
        var px = Math.round(cssSize * dpr);
        if (board.width !== px) {
            board.width = px;
            board.height = px;
            boardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            isDirty = true;
        }
    }
    function resizeBoard() {
        syncBackingStore();
        if (game) {
            drawBoard(game);
        }
    }
    function init(bd, bdImg, msg, lvl) {
        board = bd;
        boardImage = bdImg;
        message = msg;
        level = lvl;
        setLevel(parseInt(localStorage.getItem("level"), 10));
        boardCtx = board.getContext("2d");
        board.addEventListener("mousedown", tapOrClick, false);
        board.addEventListener("touchstart", tapOrClick, false);
        window.addEventListener("resize", resizeBoard, false);
        resizeBoard();
        newGame();
    }
    function newGame() {
        animatingMove = null;
        ignoreButtons = false;
        player.clearLineHistory(); // repetition history is per game line
        game = new checkers.Game();
        //game.randomBoard(2, true);
        setSelectedLocation(null);
        gameHistory = [];
        setMessage("");
        isDirty = true;
        drawBoard(game);
        doComputerMoveMaybe();
    }
    function isComputersTurn() {
        if (game.turnIsBlack()) {
            return computerPlaysBlack;
        } else {
            return computerPlaysRed;
        }
    }
    function doComputerMoveMaybe() {
        if (isComputersTurn() && game.getMoves().length > 0) {
            if (doComputerMoveTimer) {
                clearTimeout(doComputerMoveTimer);
            }
            doComputerMoveTimer = setTimeout(doComputerMove, 200);
        } else {
            instructHuman();
            ignoreButtons = false;
        }
    }
    function doComputerMove(random) {
        var move = (random ? randPlayer : player).genMove(game);
        if (move) {
            if (showAnimations) {
                animateMove(move);
            } else {
                common.assert(makeMove(move));
            }
        } else {
            return false;
        }
    }
    function undo() {
        animatingMove = null;
        player.clearLineHistory(); // abandoned-line positions must not linger
        if (computerPlaysBlack && computerPlaysRed) {
            computerPlaysRed = false;
        }
        computerPlaysBlack = false;
        do {
            if (gameHistory.length > 0) {
                game = gameHistory.pop();
            } else {
                newGame();
                break;
            }
        } while (isComputersTurn());
        setSelectedLocation(null);
        ignoreButtons = false;
        instructHuman();
        isDirty = true;
        drawBoard(game);
    }
    function generateMove(random) {
        if (ignoreButtons) {
            return;
        }
        gameHistory.push(game.copy());
        doComputerMove(random);
    }
    function autoPlayRed(value) {
        computerPlaysRed = value;
        doComputerMoveMaybe();
    }
    function autoPlayBlack(value) {
        computerPlaysBlack = value;
        doComputerMoveMaybe();
    }
    function setLevel(value) {
        if (isNaN(value)) {
            value = 1;
        }
        value = Math.max(1, value);
        // Levels meter thinking EFFORT, not lookahead: each level doubles a
        // node budget anchored at 20 nodes — the measured average cost of a
        // depth-1 search including its quiescence bonus (12.4 nodes/move),
        // rounded up so that level 2 (40) clears the full depth-2 cost
        // (~26) instead of falling two nodes short of it. Budgets are
        // device-independent and deterministic, and self-allocate depth
        // where nodes are cheap (see README). maxDepth is only a hard cap
        // so tablebase-covered positions cannot deepen without bound.
        player.maxDepth = 32;
        player.nodeLimit = 20 * Math.pow(2, value - 1);
        level.innerHTML = "Level: " + value;
        try {
            localStorage.setItem("level", value);
        } catch (e) {
        }
    }
    // A provable draw indication: the tablebase's explicit draws are
    // theoretical facts (drawn under best play by both sides), so the
    // message can only appear inside coverage and vanishes on its own if
    // a blunder makes the position decisive again — or the position grows
    // beyond what the tablebase knows. Play is never terminated by it.
    function drawIndication() {
        var tb = tablebases[checkers.getForcedJumps()];
        if (tb && tb.probe) {
            var entry = tb.probe(game); // null when mid-jump or uncovered
            if (entry && entry.v === 0) {
                return "The game is a draw.";
            }
        }
        return "";
    }
    function instructHuman() {
        var moves = game.getMoves();
        if (moves.length === 0) {
            if (game.turnIsBlack()) {
                setMessage("I win  :)");
            } else {
                setMessage("You win!");
                setLevel(player.maxDepth + 1);
            }
        } else if (game.getJumpContinuationLoc()) {
            if (checkers.getForcedJumps()) {
                setMessage("Keep jumping!");
            }
            setSelectedLocation(game.getJumpContinuationLoc());
            drawBoard(game);
        } else if (game.hasAnyJump() && checkers.getForcedJumps()) {
            setMessage("Make the jump!"); // jump instruction takes precedence
        } else {
            setMessage(drawIndication());
        }
    }
    function makeMove(move) {
        var before = game.copy();
        if (game.makeMove(move)) {
            gameHistory.push(before);
            setSelectedLocation(null);
            setMessage("");
            isDirty = true;
            drawBoard(game);
            doComputerMoveMaybe();
            return true;
        } else {
            log("Move not legal: {} to {}", move.from, move.to);
            return false;
        }
    }
    function swapTurn() {
        game = game.swapTurnCopy();
        isDirty = true;
        drawBoard(game);
        doComputerMoveMaybe();
    }

    var tablebases = {};
    function loadTablebase(path, forced) {
        var request = new XMLHttpRequest();
        var fileName = common.format("{}/end{}{}", path, checkers.getBoardSize(), forced ? "Forced" : "Unforced");
        request.open("GET", fileName, true);
        request.responseType = "arraybuffer";
        request.onload = function () {
            if (request.status !== 200) {
                log("Tablebase '{}' unavailable (HTTP {}); playing without it.", fileName, request.status);
                return;
            }
            var tb;
            try {
                tb = checkers.openTablebase(request.response);
            } catch (e) {
                log("Tablebase '{}' rejected: {}", fileName, e.message);
                return;
            }
            var tbForced = tb.getStats().forcedJumps;
            if (tbForced !== null && tbForced !== forced) {
                log("Tablebase '{}' is for forcedJumps={}, expected {}; ignoring.", fileName, tbForced, forced);
                return;
            }
            log("Loaded tablebase '{}' with {} entries.", fileName, tb.getStats().size);
            tablebases[forced] = tb;
            if (checkers.getForcedJumps() === forced) {
                player.tablebase = tb;
            }
        };
        request.send(null);
    }
    loadTablebase(".", true);
    loadTablebase(".", false);

    function setForcedJumps(value) {
        checkers.setForcedJumps(value);
        player.tablebase = tablebases[value];
        newGame();
    }
    pub.setForcedJumps = setForcedJumps;

    function resetLevel() {
        setLevel(1);
    }
    pub.resetLevel = resetLevel;

    pub.init = init;
    pub.newGame = newGame;
    pub.undo = undo;
    pub.generateMove = generateMove;
    pub.autoPlayRed = autoPlayRed;
    pub.autoPlayBlack = autoPlayBlack;
    pub.swapTurn = swapTurn;
    return pub;
}();
