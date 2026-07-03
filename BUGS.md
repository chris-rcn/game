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

### 1. `common.binarySearch` returns `0` for "not found, below minimum" — `common.js:243` — **FIXED in root copy**
The not-found return was `~maxIndex`. When the target is smaller than every element,
`maxIndex` ends at `-1` and `~(-1) === 0`, which is indistinguishable from "found at
index 0". Any caller using `result >= 0` as the found-test got a false positive.
`ResultList2.getEntry` (the only in-repo caller) survived only because it re-checks
`h0Array[i] === hash.h0` after the search.
*Evidence:* `binarySearch([10,20,30], 5) === 0` pre-fix.

Fixed by returning `~minIndex` — the standard `-(insertionPoint + 1)` convention:
misses are now always negative and `~result` is the insertion point (mid-array miss
values shift by one relative to the old convention, e.g. 15 in `[10,20,30]` now
returns -2 instead of -1; no in-repo caller consumed those values). A parity test
probes the real `end8Forced` tablebase through root and baseline `ResultList2`
side by side to prove lookups are behavior-identical, and the game-play path never
touches `binarySearch` at all. The bug remains in `baseline/common.js`.

### 2. `randomBoard`'s per-color cap never fires — `checkers.js:285` — **RESOLVED by removal**
```js
var deployed = { BLACK: 0, RED: 0 };   // string keys "BLACK"/"RED"
...
deployed[color]++;                     // color is the numeric constant 1 or 2
```
`deployed[1]` starts `undefined`, so the increment produced `NaN`, the guard
`deployed[color] === maxCheckersPerPlayer` was never true, and the `assert` inside
it was dead code. With `allowUnbalanced`, one side routinely received more than the
12-piece maximum.
*Evidence:* 400 seeded calls to `randomBoard(24, true, true)` produced a side with
**20** pieces (cap is 12).

`randomBoard` had no production callers (the sole `checkersUi.js` reference is
commented out; its real consumer was presumably the offline tablebase generator,
which is not part of the site), so rather than fix dead code it was **removed**
from the root copy along with its private helpers `randomSquare`/`randomColor` and
the `liveTileCount`/`maxCheckers`/`maxCheckersPerPlayer` constants only it used.
`checkers.seed()` and the module RNG are retained because `checkersUi.js` calls
`seed()` at init, though nothing in the engine consumes the seeded stream anymore.
The function survives unchanged in `baseline/checkers.js`.

### 3. Shipped `end8Unforced` tablebase cannot be loaded — data file + `checkers.js:113` — **FIXED in root copy**
`ResultList2` required `byteLength` divisible by 9 (two `Uint32` hashes + one byte
per entry). The published `end8Unforced` is 14,725,120 bytes (not divisible by 9),
so `size` was fractional and `new Uint32Array(buffer, 4*size, size)` threw
`RangeError` inside the XHR `onload` handler — switching off "Forced jumps"
silently played without its endgame tablebase. `end8Forced` (2,432,286 bytes)
loads fine in the legacy format.

**Forensic result: the file is not corrupt — it is a newer format the site's
reader predates.** Layout (verified against the engine's own Zobrist hashes on
150/150 real endgame positions):

| array | offset | type | content |
|---|---|---|---|
| h0 | 0 | `u32 × capacity` | first hash, sorted over the used prefix |
| h1-hi | 4·cap | `u16 × capacity` | `h1 >>> 16` |
| h1-lo | 6·cap | `u8 × capacity` | `h1 & 0xFF` |
| result | 7·cap | `u8 × capacity` | `((v+1) << 6) | distance` (unchanged encoding) |

with `capacity = byteLength/8 = 1,840,640` and `used = 230,080` (exactly 1/8
full; the rest is zero padding — the sorted-h0-prefix scan that revealed this is
reproducible from the file alone). Census: 150,186 wins, 79,894 losses, **zero
draws, zero invalid bytes**, max distance 47. Draws are deliberately absent —
`getEntry`'s "miss below the observed checker count ⇒ draw" heuristic is the
other half of this design. Win/loss distances are not ply-parity-clean because
multi-jump continuations advance the counter without switching the mover.

Fixes in the root copy:
- `ResultList2` auto-detects the layout (`%9` → legacy, `%8` → capacity-padded,
  else a descriptive `Error` instead of a deep `RangeError`), trims the zero
  padding, and matches the 23 stored h1 bits in the new format.
- `loadTablebase` in `checkersUi.js` now checks `request.status`, catches reader
  errors, and logs instead of dying inside the event handler.
- Bonus latent bug found while there: the original install condition
  `if (checkers.getForcedJumps())` would have installed **whichever tablebase
  finished loading last** while in forced mode (e.g. the unforced one) — it was
  masked only because the unforced file always threw. Now installs only when the
  loaded tablebase matches the current mode (`getForcedJumps() === forced`).

The old reader remains in `baseline/checkers.js`.

**Follow-up: v3 "CHFT" format.** Both shipped files were converted to a new
headered format combining the strengths of the two older ones: a 16-byte header
(`CHFT` magic, u32 version, u32 entryCount, u32 flags with bit 0 = forced-jumps
mode) followed by the 8-byte-per-entry arrays at exact size — no padding. The
header makes detection unambiguous (both older formats were detected only by
byte-length divisibility, which is fragile and ambiguous for lengths divisible
by 72), catches truncation via the count check, and lets `loadTablebase` refuse
a tablebase whose rules mode doesn't match. Results: `end8Forced` 2,432,286 →
2,162,048 bytes (−11%), `end8Unforced` 14,725,120 → 1,840,656 bytes (−87.5%).
The originals are preserved under `testdata/` as reader fixtures, and
`tools/convert-tablebase.js` converts any supported format with entry-for-entry
verification before writing.

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
Mitigating factor for the original site: `useTranspositionTable` defaulted to
`false`, so the shipped UI never hit this. Post-fix the default is **true** —
value-neutral at fixed depth and roughly half the leaf evaluations. The bug
remains in `baseline/players.js` for arena comparison.

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

### 6. No draw rule is ever applied — `checkers.js` / `checkersUi.js` — **NOT A BUG: confirmed design decision**
No code path ever ends a live game as a draw: `getMoves()` in a king-vs-king
shuffle stays non-empty forever. Confirmed by the author as intended: a draw is a
*game-theoretic property of the position* (neither side can force a win under
optimal play), realized as the tablebase value `v = 0` — not a clock rule that
terminates play. There is deliberately no draw clock in the game.

The `movesSinceProgress`/`drawThreshold` machinery is **generation-time
apparatus**, not a live rule: computing clockless draws by forward search needs a
progress bound to terminate, and the code says as much — `drawThreshold`'s comment
("trial and error … at least 18") records calibrating the bound until the computed
values converge, and `genZobristData` builds the `sinceProgress` hash channel
separately "so a change in drawThreshold should be fine", i.e. so the generator
could re-run with different bounds without shifting position hashes. Live
tablebase lookups use `hashBase()` (position only, no clock), consistent with the
stored values being clockless positional truths; `hash(true)` was the generator's
memo key.

Consequences, all consistent with the design: the shipped UI always has a human on
one side (the autoplay-both-sides functions have no buttons in `index.html`), so a
dead-drawn game is abandoned by the human, and a computer draw withholds the
level-up exactly like a computer win; the search is draw-aware only where it
matters (tablebase hits propagate 0); and the arena adjudicates draws externally
as a harness convenience (`--draw-plies`/`--max-plies`), which remains the
sanctioned approach rather than an engine rules change.

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

### 8. `common.SuperRandom` is never exported — `common.js:145` — **RESOLVED by removal**
The line after the class definition read `pub.Random = Random;` (a duplicate of
line 118) where `pub.SuperRandom = SuperRandom;` was clearly intended, so the class
was unreachable. Its own comment admitted "Totally untested", nothing used it (its
one dependency, `shuffle`, is shared and stays), and exporting untested dead code
adds surface without value — so the class and the duplicate export line were
**removed** from the root copy. It survives unchanged in `baseline/common.js`.

### 9. Jump continuation is forced even when "Forced jumps" is off — `checkers.js:506,662` — **NOT A BUG: confirmed design decision**
With `jumpsAreForced = false` a player may decline to *start* a jump, but once a
multi-jump has begun, `calcMoves` offers only the continuation jumps and `makeMove`
rejects everything else (`if (jumpContinuationLoc) return false;` in the slide
branch), even though most "optional capture" rule sets allow stopping mid-chain.

Confirmed by the author as deliberate: the UI's click-source/click-destination
interaction offers no gesture meaning "end the jump here", so the rules enforce
continuation as a house rule rather than offer an option the human could never
exercise. The UI is consistent with this — mid-chain it auto-selects the
continuation square in both modes (only the "Keep jumping!" message is gated on
forced mode). The rule binds both sides equally, the search models it correctly,
and the quiescence stand-pat logic deliberately never offers a decline option
mid-chain. If rule-correct optional continuation is ever wanted, it requires a
coordinated change: a UI end-turn gesture (e.g. clicking the jumping piece), an
explicit end-turn action in the engine's mid-chain move set, search support for
the stop option, and regeneration of any unforced tablebase.

### 10. UI animation timer runs ~11x too fast — `checkersUi.js:25` — **FIXED in root copy**
```js
var animationFrames = 1000 * animationFramesPerSec / animationPeriodMs; // 66.7
var animationFramePeriodMs = animationPeriodMs / animationFrames;       // 4.5ms
```
For 20 fps over a 300 ms animation, that should be `6` frames at `50` ms. The two
errors cancelled so the animation still lasted 300 ms, but `setInterval(animate, 4.5)`
redrew at ~220 Hz instead of 20 Hz, burning CPU for nothing. Fixed during the
cleanup pass: frames = period × fps / 1000, frame period = 1000 / fps; the
animation duration is unchanged.

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

### 12. ~~Shipped tablebases misclassify deep decisive endgames as draws~~ FIXED — data files
Discovered while validating the new generator (`tools/generate-tablebase.js`)
against the shipped tables. An independent layered-retrograde solve of the
complete ≤3-piece space agrees with **every one of the 500,334 shipped entries
on value (zero mismatches, both modes)** — but finds ~141,000 additional
decisive states per mode that the shipped tables omit, 99.97% of them deep
(canonical distance ≥ 11, mostly 21+). The omission pattern matches the
original generator's `drawThreshold`-bounded forward search: lines with long
no-progress stretches could not be resolved within the bound and were dropped,
and the reader's miss-means-draw heuristic then silently reports those *wins*
as *draws*. Shipped distances are also non-canonical (inflated by even
amounts on ~25-33% of entries; ours are provably fastest-win/slowest-loss).
**Fixed by regeneration**: the canonical `end8Forced`/`end8Unforced` are now
≤3-piece tables produced by the retrograde generator in the compact indexed
v4 format (411,906 decisive entries per mode vs the originals' 270k/230k —
the difference is exactly the formerly-missing deep wins). Draws are
explicit and exact (clockless fixpoint semantics) and distances are
canonical. The original values live on as `testdata/end8*.v3` fixtures and
the suite pins the generator against them. A ≤4-piece build was validated
(+~33 Elo forced, flat unforced) but is not the served default — 19 MB/mode
vs 651 KB was judged not worth it; it is kept as `end8*.4p` (see README).

## Minor notes

- ~~`checkersUi.js:112` — `if (selectedLocation >= 0)` is true for `null`~~
  **FIXED** in cleanup: now `selectedLocation !== null`.
- ~~`hasJump`/`hasSlide` loop over 4 directions even for pawns~~ **FIXED** in
  cleanup: loops now use `diags.length`; the `undefined`-diagonal reads (harmless
  `NaN` lookups) are gone.
- ~~`common.format` expands `$&`-style replacement patterns in argument values~~
  **FIXED** in cleanup: a function replacement keeps values literal (tested).
- ~~`checkers.getTablebaseFileName()` returns a `pub/` path the UI never uses~~
  **REMOVED** in cleanup (unused; the UI builds its own name).
- `negamax` sets `result.valueIsKnown = false` on a TT_EXACT hit (`players.js`),
  which looks like it should be `true`; the field is only consumed internally.
  Left as-is.
- `negamax`'s depth-0 single-move shortcut returns a result with **no `value`**,
  so `genMoveDetail(...).value` is `undefined` whenever the root move is forced —
  callers must not rely on it. Left as-is (documented behavior).

## Cleanup pass (behavior-neutral)

Applied after all bugs were resolved; verified by the full suite plus an arena
bit-identity check (exact mirrored ties vs the pre-cleanup snapshot):

- Removed dead code: `common.formatAuto`, `common.logProps` (which was also
  broken — it printed `value=value`), `common.Timer`, `common.CompactObjectArray`,
  `checkers.getTablebaseFileName`, the write-only `ttSize` counter, negamax's
  vestigial `color` parameter, and `binarySearch`'s unused `resultIndex`.
- `players.js` reuses `checkers.isJump` instead of a local duplicate.
- The iterative-deepening time limit is an explicit `Infinity` when no budget is
  set (previously a `> NaN` comparison that happened to behave).
- The search's `undo` assignment no longer hides inside an `assert()` argument.
- `checkersUi.js`: `parseInt(..., 10)`; animation timer fix (#10 above).
