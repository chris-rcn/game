# Bugs found in the CHF checkers engine

Source: `http://chf-checkers.s3-website-us-west-2.amazonaws.com` (mirrored into this
repo unmodified). Every numbered bug below has a corresponding reproducing test in
`test/`, marked `KNOWN BUG #n` and run as a TODO test so the suite stays green while
the bugs remain unfixed. Run `npm test` to see them.

The core rules engine is in good shape: ~15,000 plies of randomized self-play
passed invariant checks (piece lists consistent with the board, undo restores the
exact state and Zobrist hash, checked `makeMove` accepts *exactly* the `getMoves()`
set in both forced- and unforced-jump modes, no board wrap-around). The bugs are
concentrated in the utility library, the search player, and the shipped data files.

## High impact

### 1. `common.binarySearch` returns `0` for "not found, below minimum" — `common.js:243`
The not-found return is `~maxIndex`. When the target is smaller than every element,
`maxIndex` ends at `-1` and `~(-1) === 0`, which is indistinguishable from "found at
index 0". Any caller using `result >= 0` as the found-test gets a false positive.
`ResultList2.getEntry` (the only in-repo caller) survives only because it re-checks
`h0Array[i] === hash.h0` after the search. Fix: return `~minIndex` (the standard
`-(insertionPoint + 1)` convention).
*Evidence:* `binarySearch([10,20,30], 5) === 0`.

### 2. `randomBoard`'s per-color cap never fires — `checkers.js:285`
```js
var deployed = { BLACK: 0, RED: 0 };   // string keys "BLACK"/"RED"
...
deployed[color]++;                     // color is the numeric constant 1 or 2
```
`deployed[1]` starts `undefined`, so the increment produces `NaN`, the guard
`deployed[color] === maxCheckersPerPlayer` is never true, and the `assert` inside it
is dead code. With `allowUnbalanced`, one side routinely receives more than the
12-piece maximum. Fix: key the object by the numeric constants.
*Evidence:* 400 seeded calls to `randomBoard(24, true, true)` produced a side with
**20** pieces (cap is 12).

### 3. Shipped `end8Unforced` tablebase cannot be loaded — data file + `checkers.js:113`
`ResultList2` requires `byteLength` divisible by 9 (two `Uint32` hashes + one byte
per entry). The published `end8Unforced` is 14,725,120 bytes (not divisible by 9),
so `size` is fractional and `new Uint32Array(buffer, 4*size, size)` throws
`RangeError`. In the browser this exception fires inside the XHR `onload` handler,
so switching off "Forced jumps" silently plays without its endgame tablebase.
`end8Forced` (2,432,286 bytes) loads fine and is correctly sorted. Related hardening
gap: `loadTablebase` in `checkersUi.js` never checks `request.status`, so an HTTP
error page would be fed to `ResultList2` the same way.

### 4. `players.Search` transposition table reuses under-searched entries — `players.js:101` — **FIXED in root copy**
`ttEntry.d` stored the node's **distance from the root**, and the reuse condition was
`ttEntry.d >= depth`. Larger distance-from-root means *less* remaining search depth,
so the condition was inverted: it accepted cached values computed with **shallower**
lookahead than the current node needs, while rejecting deeper ones. Search results
were visit-order dependent, and TT-enabled play was observably passive (an early
arena run at depth 3 with TT + iterative deepening drew all 10 games).

Fixed by storing the **remaining** depth (`currentMaxDepth - depth`, clamped at 0
since every node at or beyond `currentMaxDepth` is in the same depth-independent
quiescence regime) and reusing only when `stored remaining >= needed remaining`.
Residual note: TT-on can still differ from TT-off by ~1e-5 — reusing an entry that
was searched *deeper* than needed is legitimate but carries different depth-decay
tie-break noise (see #7). The old bug produced errors thousands of times larger:
on a pinned depth-9 position, pre-fix TT shifted the root value 0.2307 → 0.2000,
while post-fix TT agrees with plain search exactly and evaluates ~45% fewer leaves.
Mitigating factor for the original site: `useTranspositionTable` defaults to
`false`, so the shipped UI never hit this. The bug remains in
`baseline/players.js` for arena comparison.

### 5. `genMoveDetail` checks `.forced` on the wrong object — `players.js:238` — **FIXED in root copy**
`negamax` flags the *Move* (`moves[0].forced = true; result.move = moves[0]`), but
the iterative-deepening loop tested `move.forced` on the *result wrapper*, which is
always `undefined`. Two features died from this one line:
- the forced-move early exit never triggered (the loop deepened to `maxDepth` even
  when there is only one legal move);
- `killer = move` stored the wrapper — which has no `from`/`to` — so the
  killer-move comparison `moves[m].from === killer.from` never matched and the
  `useKillerMove` optimization was a silent no-op (killer on/off was
  bit-identical).
Fixed by reading `result.move.forced` and storing `killer = result.move`. Both
features only run in the iterative-deepening / time-budget path, so fixed-depth
play is untouched. Post-fix, killer ordering demonstrably engages — node counts
change relative to `useKillerMove=false` (they were bit-identical before) while
the root value is unchanged — and a forced-move position returns after the
first iteration. The size (and sign) of the node savings varies by position
and depth. The bug remains in `baseline/players.js` for arena comparison.

## Medium / low impact

### 6. No draw rule is ever applied — `checkers.js` / `checkersUi.js`
The engine diligently tracks `movesSinceProgress` and exposes
`getDrawThreshold()`, and the Zobrist hash even mixes the counter in — but no code
path ever ends the game as a draw. `getMoves()` in a king-vs-king shuffle stays
non-empty forever, `players.Random.playout` relies on random termination, and the
UI would ping-pong endlessly if both sides were computer-controlled.

### 7. Alpha-beta interacts inconsistently with the depth-decay factor — `players.js:184` — **FIXED in root copy**
`childResult.value *= 0.99999` (the "prefer shorter wins" tie-break) was applied
*after* the child was searched with the undecayed `(alpha, beta)` window. Values at
the window edges were therefore pruned against slightly different numbers than the
parent later compared, and the root value with `doAlphaBeta` on vs off differed by
~1e-5 relative — enough to flip the chosen move on near-ties.

Fixed by folding the decay into the child window: the parent accepts `v` iff
`0.99999·v` clears its bounds, so the child is searched with
`(alpha/0.99999, beta/0.99999)` (negated for opponent nodes as before). Pruned
search is now **exactly** equal to plain negamax: across 50 seeded positions in
both jump modes at depth 6, the maximum root-value difference is literally 0 while
pruning still eliminates 95-99.9% of leaf evaluations. The suite enforces exact
equality (`===`) on a pinned position and a seeded batch. The bug remains in
`baseline/players.js` and `snapshots/after-killer-fix/` for arena comparison.

### 8. `common.SuperRandom` is never exported — `common.js:145`
The line after the class definition reads `pub.Random = Random;` (a duplicate of
line 118) where `pub.SuperRandom = SuperRandom;` was clearly intended, so the class
is unreachable. (Its own comment admits "Totally untested".)

### 9. Jump continuation is forced even when "Forced jumps" is off — `checkers.js:506,662`
With `jumpsAreForced = false` a player may decline to start a jump, but once a
multi-jump has begun, `calcMoves` offers only the continuation jumps and `makeMove`
rejects everything else (`if (jumpContinuationLoc) return false;` in the slide
branch). In most "optional capture" rule sets, stopping mid-chain is allowed. At
minimum the behavior contradicts the UI checkbox label; the UI even shows the
"Keep jumping!" prompt only in forced mode while still enforcing the continuation
in unforced mode.

### 10. UI animation timer runs ~11x too fast — `checkersUi.js:25`
```js
var animationFrames = 1000 * animationFramesPerSec / animationPeriodMs; // 66.7
var animationFramePeriodMs = animationPeriodMs / animationFrames;       // 4.5ms
```
For 20 fps over a 300 ms animation, that should be `6` frames at `50` ms. The two
errors cancel so the animation still lasts 300 ms, but `setInterval(animate, 4.5)`
redraws at ~220 Hz instead of 20 Hz, burning CPU for nothing.

### 11. Quiescence search never runs in unforced mode — `players.js:142` — **FIXED in root copy**
The "keep searching, this position is noisy" test was
```js
var lastAvailableMove = moves[moves.length - 1];
var canContinue = pub.doQuiesce && (moves.length === 1 ||
    Math.abs(lastAvailableMove.from - lastAvailableMove.to) > maxDiagonalOffset);
```
Move generation always emits jumps before slides, so in unforced mode the
*last* move is a slide whenever any slide exists and quiescence never engages
(in forced mode every move is a jump when any jump exists, which hid the bug).
The search therefore evaluated mid-capture-exchange positions at face value —
a textbook horizon effect: at the leaf, a freshly grabbed piece counts as won
material even when the recapture is forced.

The fix tests `moves[0]` instead, which is a jump iff any jump is available —
but that alone is not enough: in unforced mode the side to move may *decline*
the capture and slide, and extending the search over slides below the horizon
recurses without bound (instant stack overflow in match play; plausibly why
the original check "worked" — it accidentally disabled the whole path). So
when the move list mixes jumps and slides at quiescence depth, the fixed code
searches **captures only with the static eval as a stand-pat floor** —
standard quiescence for optional-capture rules, and termination is guaranteed
because every searched move removes a piece. Forced-mode move lists are never
mixed, so forced-mode play is provably bit-identical to the old code, and the
arena's shadow replay confirmed zero rules divergences in both modes.
*Evidence:* in unforced mode at depth 1, the poisoned-capture position in
`players.test.js` was played 48>32 (piece immediately recaptured) before the
fix and 48>28 after. This bug was selected as the biggest playing-strength fix
because the other search bugs are gated off by default (#4 needs
`useTranspositionTable`, #5 needs iterative deepening) or are ~1e-5 noise (#7).
The bug remains present in `baseline/players.js` for arena comparison.

## Minor notes (no tests)

- `checkersUi.js:112` — `if (selectedLocation >= 0)` is true for `null`
  (`null >= 0` is `true` in JS); it only escapes notice because the resulting
  highlight rect lands off-canvas.
- `checkers.js:578` (`hasJump`) and `:605` (`hasSlide`) loop over 4 directions even
  for pawns whose diagonal arrays have length 2; the reads of `diags[2]`/`diags[3]`
  yield `undefined`, producing `NaN` board lookups that happen to be harmless.
- `common.format` uses `String.replace` with a literal pattern, so argument values
  containing `$&`, `$'` etc. are expanded as replacement patterns
  (`format("{}", "$&")` returns `"{}"`).
- `negamax` sets `result.valueIsKnown = false` on a TT_EXACT hit (`players.js:104`),
  which looks like it should be `true`; the field is only consumed internally.
- `negamax`'s depth-0 single-move shortcut returns a result with **no `value`**
  (`players.js:152-156`), so `genMoveDetail(...).value` is `undefined` whenever the
  root move is forced — callers must not rely on it.
- `checkers.getTablebaseFileName()` returns `pub/end8...` while the UI loads
  `./end8...`; the copy in `checkersUi.js:345` duplicates the format string instead
  of calling the engine function.
