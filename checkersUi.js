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
    var animationFramesPerSec = 20;
    var animationPeriodMs = 300;
    var animationFrames = animationPeriodMs * animationFramesPerSec / 1000;
    var animationFramePeriodMs = 1000 / animationFramesPerSec;
    var animationVelocity = 1 / animationFrames;
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
        if (!isDirty) return;
        isDirty = false;
        var pad = 2;
        var size = board.clientHeight - 2 * pad;
        var tileSize = size / boardSize;
        var row, column;
        var x, y;
        if (boardSize === 8) {
            boardCtx.drawImage(boardImage, 0, 0, board.clientHeight, board.clientHeight);
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
    function animate() {
        if (animatingMove) {
            animatingProgress += animationVelocity;
            //log("animatingProgress={}", animatingProgress);
            isDirty = true;
            if (animatingProgress >= 1) {
                var move = animatingMove;
                animatingMove = null;
                common.assert(makeMove(move));
            }
            drawBoard(game);
        } else {
            animatingProgress = null;
        }
    }
    function animateMove(move) {
        animatingProgress = 0;
        animatingMove = move;
        ignoreButtons = true;
    }
    function tapOrClick(event) {
        if (ignoreButtons) {
            return;
        }
        var size = board.clientHeight;
        var tileSize = size / boardSize;
        var mouseX = event.pageX - board.offsetLeft;
        var mouseY = event.pageY - board.offsetTop;
        var row = Math.floor(mouseY / tileSize);
        var column = Math.floor(mouseX / tileSize);
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
    function init(bd, bdImg, msg, lvl) {
        board = bd;
        boardImage = bdImg;
        message = msg;
        level = lvl;
        setLevel(parseInt(localStorage.getItem("level"), 10));
        boardCtx = board.getContext("2d");
        board.addEventListener("mousedown", tapOrClick, false);
        board.addEventListener("touchstart", tapOrClick, false);
        newGame();
        setInterval(animate, animationFramePeriodMs);
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
        player.maxDepth = value;
        // Levels are pure depth; the engine's default quiesceDepth = 1
        // applies at every level, giving a near-uniform ladder (see README).
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
                return "Draw with best play";
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
