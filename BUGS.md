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

### 4. `players.Search` transposition table reuses under-searched entries — `players.js:101`
`ttEntry.d` stores the node's **distance from the root**, and the reuse condition is
`ttEntry.d >= depth`. Larger distance-from-root means *less* remaining search depth,
so the condition is inverted: it accepts cached values computed with **shallower**
lookahead than the current node needs, while rejecting deeper ones. Search results
become visit-order dependent. Fix: store the remaining depth
(`currentMaxDepth - depth`) and require `storedRemaining >= neededRemaining`.
Mitigating factor: `useTranspositionTable` defaults to `false`, so the shipped UI is
unaffected.
*Evidence:* deterministic midgame position (see `players.test.js`) where the root
value differs with the TT on vs off.

### 5. `genMoveDetail` checks `.forced` on the wrong object — `players.js:238`
`negamax` flags the *Move* (`moves[0].forced = true; result.move = moves[0]`), but
the iterative-deepening loop tests `move.forced` on the *result wrapper*, which is
always `undefined`. Two features die from this one line:
- the forced-move early exit never triggers (the loop deepens to `maxDepth` even
  when there is only one legal move);
- `killer = move` stores the wrapper — which has no `from`/`to` — so the
  killer-move comparison `moves[m].from === killer.from` never matches and the
  `useKillerMove` optimization is a silent no-op.
Fix: use `move.move.forced` / `killer = move.move`.

## Medium / low impact

### 6. No draw rule is ever applied — `checkers.js` / `checkersUi.js`
The engine diligently tracks `movesSinceProgress` and exposes
`getDrawThreshold()`, and the Zobrist hash even mixes the counter in — but no code
path ever ends the game as a draw. `getMoves()` in a king-vs-king shuffle stays
non-empty forever, `players.Random.playout` relies on random termination, and the
UI would ping-pong endlessly if both sides were computer-controlled.

### 7. Alpha-beta interacts inconsistently with the depth-decay factor — `players.js:184`
`childResult.value *= 0.99999` (the "prefer shorter wins" tie-break) is applied
*after* the child was searched with the undecayed `(alpha, beta)` window. Values at
the window edges are therefore pruned against slightly different numbers than the
parent later compares, and the root value with `doAlphaBeta` on vs off differs by
~1e-5 relative — enough to flip the chosen move on near-ties. Fix: fold the decay
into the bounds passed to the child (or apply the decay inside the child before
bound checks).
*Evidence:* deterministic position in `players.test.js` (`KNOWN BUG #7`).

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
