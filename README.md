# CHF Checkers

A mirror of the checkers engine served at
`http://chf-checkers.s3-website-us-west-2.amazonaws.com`, plus a Node.js test
suite and a bug report.

## Layout

Original site files (unmodified):

| File | Purpose |
|---|---|
| `index.html` | Browser entry point |
| `common.js` | Utility library (format/log, seeded RNG, binary search, ...) |
| `checkers.js` | The rules engine: board, move generation, make/undo, Zobrist hashing, tablebase reader |
| `players.js` | Players: random rollouts and a negamax search with alpha-beta, quiescence, iterative deepening |
| `checkersUi.js` | Canvas UI (browser only) |
| `board.jpg` | Board artwork |
| `end8Forced`, `end8Unforced` | Endgame tablebases: regenerated **≤4-piece** tables in the v4 "CHFI" indexed format (19.1 MB raw, ~4.8 MB gzipped on the wire — serve pre-compressed) |
| `testdata/end8Forced.legacy`, `testdata/end8Unforced.padded` | The original site downloads, kept as fixtures for the legacy 9-byte and capacity-padded 8-byte reader paths |
| `testdata/end8Forced.v3`, `testdata/end8Unforced.v3` | The original ≤3-piece values converted to v3, kept as the shipped-data oracle for generator/regression tests |
| `tools/convert-tablebase.js` | Converts any supported hash-keyed tablebase format to v3 (verifies entry-for-entry before writing) |
| `tools/generate-tablebase.js` | Retrograde tablebase generator; writes v4 (or `--v3`) for any piece count |
| `tools/verify-generator.js` | Proves the generator reproduces every originally shipped value (run once per mode; see BUGS.md #12) |

Tablebase v3 format ("CHFT", hash-keyed): 16-byte header (`CHFT` magic,
u32 version, u32 entryCount, u32 flags with bit 0 = forced-jumps mode)
followed by exact-sized arrays
`u32 h0[n] | u16 (h1>>>16)[n] | u8 (h1&0xFF)[n] | u8 resultAndDist[n]`.
It combines the legacy format's exact sizing with the newer format's leaner
8-byte entries, and the header makes detection unambiguous, catches truncation,
and lets the UI refuse a tablebase generated for the wrong rules mode.
`ResultList2` reads all three hash-keyed formats.

Tablebase v4 format ("CHFI", dense-indexed): 16-byte header (`CHFI` magic
`0x49464843`, u8 version = 1, u8 flags with bit 0 = forced-jumps mode,
u8 maxPieces) followed by exactly one byte per base position, addressed by
a perfect rank (no hashes, no per-entry keys, no binary search):

    rank = sectionOffset(k) + (comboRank · 4^k + digitsRank) · 2 + turnBit

where `k` is the piece count (2..maxPieces), `comboRank` is the combinadic
rank of the occupied dark-square set, `digitsRank` packs each piece as
`(RED?2:0)+(KING?1:0)` in square order, and `turnBit` is the side to move.
Byte encoding: `255` = position absent/unreachable, `64` = explicit draw,
otherwise `((v+1)<<6) | min(d,63)` for value `v` in {-1,+1} and distance
`d`. Mid-jump states are not stored (the search recurses through
continuations until the jump ends); elimination terminals are answered by
the search's no-moves path. One byte per slot makes the shipped ≤4-piece
table 19.1 MB/mode — versus ~98 MB for its 12.8M labeled positions at 8
bytes each in v3 — compressing to ~4.8 MB with gzip for transport (a ≤3
build is 651 KB, vs 2.1 MB in v3), and probing is O(1). `openTablebase`
sniffs the magic and returns a `TablebaseV4` (`probe(game)`) for CHFI
files or a `ResultList2` (`getEntry(hash)`) otherwise; the search accepts
either.

Added in this repo:

- `test/` — Node test suite (`node:test`, no dependencies)
- `BUGS.md` — the bugs found, each cross-referenced to a reproducing test
- `baseline/` — frozen snapshot of the engine as mirrored ("old" version); never edit
- `arena.js` — plays the root ("new") engine against `baseline/` for many games
  in both forced-jump modes

## Running

No refactoring of the engine was required: `common.js`, `checkers.js` and
`players.js` already carry CommonJS shims (`isNodeJs()` / `exports` /
`require`), so they load directly under Node. Only `checkersUi.js` is
browser-bound. Requires Node 18+ (uses the built-in test runner).

```sh
npm test
```

Expected output: all functional tests pass; 8 tests marked `KNOWN BUG` /
`DESIGN GAP` run in TODO mode — they fail by design against the current code
and document the bugs in `BUGS.md`. Fixing a bug will make its TODO test start
passing.

To play the game locally, serve the directory over HTTP (the UI XHRs the
tablebase files):

```sh
npx http-server . -p 8080   # then open http://localhost:8080/
```

## Arena: new vs old

Before fixing anything, `baseline/` was frozen as the "old" version. Bug fixes
go in the root files and are validated head-to-head. The arena's job is
**primarily regression prevention, secondarily strength measurement**: every
run leads with a regression line (rules divergences, illegal moves, contained
player crashes) and exits non-zero on any alarm — including self-play
asymmetry when both sides are configured identically, which would indicate a
determinism regression. The score/Elo lines below it are the strength signal.

```sh
npm run arena                            # new vs baseline, 100 games per mode, depth 4
node arena.js --games 200 --depth 5      # bigger, deeper
node arena.js --a new --b new            # self-play regression check (must tie exactly)
node arena.js --forced on --verbose      # one mode, per-game lines
```

Fixes to feature-gated code paths need those features enabled during play.
Any public `Search` field can be set per side (or both) from the CLI:

```sh
node arena.js --opts useTranspositionTable=true       # arena-test the TT fix (#4)
node arena.js --opts useIterativeDeepening=true       # exercise ID + killer move (#5)
node arena.js --opts-a quiesceDepth=0                 # asymmetric feature comparison
node arena.js --max-seconds 0.05                      # time-budgeted search (nondeterministic;
                                                      #   the symmetry alarm is skipped)
```

Unknown option names fail fast before any game is played.

As fixes accumulate, comparing only against `baseline/` conflates their
effects. `--a`/`--b`/`--referee` therefore also accept snapshot directories
(any directory holding `common.js`/`checkers.js`/`players.js`), and
`snapshots/` holds intermediate states reconstructed from git — see
`snapshots/README.md`. `baseline/` remains the permanent anchor for
cumulative measurements; snapshot the pre-fix commit when you want a fix
measured in isolation:

```sh
node arena.js --b snapshots/after-tt-fix --opts useIterativeDeepening=true
```

How it stays fair and meaningful:

- The two versions load as **independent Node modules**, so module-level state
  (forced-jump flag, RNGs) cannot leak between them; the chosen mode is set on
  every copy.
- Games run in **pairs sharing a seeded random opening with colors swapped**,
  and players are built fresh per game — identical versions therefore mirror
  exactly and score exactly 50%, which the test suite asserts.
- One engine (default: new) is the **referee** owning the authoritative game;
  each player rebuilds the position in its own engine from `getState()` JSON.
  A move the referee rejects loses the game for that player.
- A **shadow game in the other version replays every move** and any rejection,
  board mismatch, or legal-move-set mismatch is reported as a divergence (and
  a non-zero exit code) — the alarm for fixes that change the rules.
- The engine never declares draws (BUGS.md #6), so the arena adjudicates:
  `--draw-plies` (default 50) plies without a capture or pawn advance, or
  `--max-plies` (default 300) total, is a draw.

Run `node arena.js --help 2>/dev/null || head -50 arena.js` for the full flag
list (documented in the header comment).

### Endgame tablebases: on by default

`Search.tablebase` semantics: `undefined` (the default) means **auto** — under
Node the engine lazily loads the mode-matching canonical file itself; in the
browser it stays empty until the UI's async fetch injects one. `null` means
explicitly off; an object is used as given. Tablebases are on unless they need
to be off — the original null default was an artifact of the browser's async
loading that silently became "off unless every consumer remembered."

Arena search players share one mode-matching tablebase instance by default
(`--no-tablebase` to disable) — earlier experiments played endgames blind,
which is now fixed.

Same principle applied to the repaired transposition table:
`Search.useTranspositionTable` now defaults to **true** — measured
value-neutral at fixed depth (49.2% vs plain over 60 games) and ~17% faster
with even one side using it. Iterative deepening stays off by default: at
fixed depth its re-search overhead is not recovered (measured slower with no
strength gain); it belongs to time-budgeted play (`--max-seconds`), which
enables it. Alongside this, tablebase hits in the search are decayed
by their distance-to-result (`v × 0.99999^d`): without that gradient every
winning move ties at the same value and the engine meanders inside won
regions instead of converting. The distance fix measured +29 Elo in forced
mode (54.1% ± 4.9 over 400 games/mode vs value-only tablebase use; unforced
flat at 50.4%, where games reach the ≤3-piece covered region far less often).

**All prior tuning conclusions were re-validated with tablebases on**
(depth 4): kingValue 1.4 vs 2.0 → 57.1% / 52.1% (confirmed, was 54.4/53.3
blind); homeRow 0.1 vs 0 → 61.6% / 59.3% (confirmed, was 59.1/59.8);
rank bonus 0.01 → 45.0% / 43.3% (still rejected); support 0.025+fullHome vs
equal back-row raise → 49.0% / 43.3% over 200/mode (still rejected).

### Repetition handling (`Search.repetitionDraws`, on by default)

The game deliberately has no repetition rule, but revisiting a position
already seen in the actual game line has provably achieved nothing — any
win available at the revisit was available at the first visit. The search
therefore scores any in-tree return to a previously faced position (or to
an ancestor on the current search line) as a draw (0): the side that is
ahead steers away from shuffling, the side that is behind steers toward
it. The check runs before the transposition table and tablebase reads
(the draw score is path-dependent, so neither cache may override it), and
line history resets automatically when a new game is detected (checker
count rises) or explicitly via `clearLineHistory()` (the UI calls it on
new game and undo).

This closes the engine's shuffle failure mode in won-but-beyond-horizon
endgames: in the pinned 2-kings-vs-1 test with the tablebase off, the
deterministic depth-4 search repeats 24 faced positions in 60 plies
without the flag and **zero** with it. Arena, on vs off (depth 4, 400
games/mode): 52.5% / 51.5% ± 4.9 (52.0% ± 3.5 pooled) — a small gain on
top of the behavioral fix. Reproduce with:

```sh
node arena.js --a new --b new --opts-b repetitionDraws=false --games 400
```

### Search characteristics (measured)

At depth 4 with current defaults: quiescence is worth **+219 Elo forced /
+163 unforced** at equal depth, versus **+165 / +153** for one extra ply
without it — and head-to-head, d4-with-quiescence beats d5-without by
+72 / +23. Cost on identical position sets: quiescence multiplies wall time
by ×2.4 (forced) and ×4.3 (unforced); an extra ply costs ×2.3 / ×3.1. So in
forced mode quiescence delivers more strength than a ply at the same price;
in unforced mode raw depth is marginally more time-efficient but quiescence
still wins at equal depth. (The originally shipped UI ran with quiescence
fully off, forfeiting ~200 Elo; it now plays `quiesceDepth = 1` — see below.)

`doQuiesce` was converted to a graded budget, `Search.quiesceDepth`: the
number of plies past the horizon the search may extend while a capture is
pending (or the move is forced). 0 ≡ the old `false`, Infinity ≡ the old
`true`, and intermediate values are new strength rungs. **The default is 1
everywhere — engine, arena players, and UI** — the measured best
Elo-per-time configuration; note that at *fixed* depth more budget is
stronger (Infinity beats 1 by ~+135/+33 Elo chained), so set
`quiesceDepth=Infinity` when comparing at equal depth rather than equal
time. Measured
ladder at depth 4 (forced/unforced, warmed best-of-3 costs): qd0→qd1
**+172/+117 Elo** for ×1.67/×1.88 time; qd1→qd2 +76/+19 for ×1.20/×1.27;
qd2→∞ +60/+14 for ×1.11/×1.56. The first budget ply delivers +232/+129 Elo
per time-doubling — better than a full ply (+140/+93) in **both** modes,
since it buys exactly the refutation one ply past the horizon. (Earlier
×2.4/×4.3 full-quiescence cost figures were JIT-warmup-inflated; warmed
costs are ×2.2/×3.7.)

### UI levels are node budgets (`nodeLimit = 20 × 2^(level−1)`)

UI levels meter thinking *effort*, not lookahead: level N gives the
engine a budget of `20 × 2^(level−1)` nodes per move (`Search.nodeLimit`
riding iterative deepening; `maxDepth = 32` remains only a hard cap so
tablebase-covered positions cannot deepen without bound). The anchor is
the measured average cost of a depth-1 search including its quiescence
bonus (12.26 forced / 12.58 unforced nodes per move over 60 games),
rounded up to 20. Two fixes made level 2 a real rung: anchored at
exactly 12, level 2's budget (24) fell short of the measured full
depth-2 cost (~26 nodes), and the deepening predictor's initial growth
guess of 3× additionally refused the second iteration even at budget
40 — both measured as a dead rung (+20/+3 Elo, then +26/+35). With the
20 anchor and the initial guess lowered to the clamp floor (2×, near
the measured ~1.4× depth-1→2 increment), L1→L2 measures **+114/+117**.
**Level 1 still plays essentially the old depth-1 level**, and each
level doubles the budget from there. Budgets are device-independent and
deterministic — unlike time limits, the same level plays identically on
any hardware — and they self-allocate: the same spend searches deeper
where subtrees are cheap (forced sequences, tablebase-covered regions)
and shallower in expensive quiet positions, which also compresses the
worst-case-to-median move-time ratio from the depth ladder's 12–16× to
4–7×. Calibration: budget ≈ depth equivalents measured at 30 ≈ d1,
100 ≈ d2, 2000 ≈ d4, ~4500 ≈ d5, ~10000 ≈ d6, so the doubling ladder
reaches d6 strength near level 10 with headroom above that the depth
ladder could not afford. Measured steps (120/mode,
forced/unforced): 20→40 +114/+117 (post-fix), and on the 12-anchored
scale 24→48 +86/+117, 48→96 +176/+165, 96→192 +124/+76 — a ~+100 Elo
average step, half the old depth ladder's, spanning in five levels
what depth spanned in three.

The previous depth-based ladder (levels = pure depth at the engine
default `quiesceDepth = 1`) measured L1→L2 +255/+207, L2→L3 +207/+225,
L3→L4 +238/+151 over 200 games/mode — near-uniform steps with no
beginner cliff. The entry level plays "greedy but not suicidal" (it beat
the original piece-hanging L1 200-0-0); the old punching bag was
deliberately not retained. Alternatives measured and set aside along the
way: `qd = level − 1` (restores the punching bag but steepens the early
ladder: +1040/∞, +301/+266, …), a hand-built level table (messy to
describe), and a threshold-triggered endgame bonus ply (the threshold
that bought Elo also ~2.4×'d the worst-case move time; reverted).

Quiescence-vs-depth crossover: in Elo per doubling of think time, forced
mode favors quiescence from depth 4 on (175 vs 140, then 151 vs 146; by
depth 6 its cost multiple ×1.65 vs a ply's ×2.6 decides it outright), while
unforced mode favors raw depth at 4-5 (78 vs 93, 83 vs 114) and flips at
depth 6 (66 vs 56) as the ply's value collapses (+147 → +87) faster than
quiescence's (+147 → +111) and their cost curves cross. **From depth ~6,
quiescence is the better use of time in both modes** (crossover ±1 ply given
error bars; every underlying trend is monotone).

The value of a ply diminishes steeply (no quiescence, 400 games/mode,
forced/unforced): d1→d2 **+920/+1040 Elo** (saturated — a floor; depth 1
cannot see the opponent's reply and hangs material constantly), d2→d3
+319/+250, d3→d4 +237/+229, d4→d5 +165/+153 — roughly 0.72× per step after
the first. Quiescence at d4 (+219/+163) is worth more than the uniform
d4→d5 ply because it extends selectively where the horizon lies. Product
note: the UI's level ladder was linear in depth but wildly nonlinear in
strength (level 1→2 ≈ 1000 Elo, level 4→5 ≈ 160) — addressed by playing
`quiesceDepth = 1` at every level, which makes the rungs nearly uniform.

### Overall strength delta vs the original (measured)

Head-to-head at depth 4 (UI level 4 vs UI level 4), 400 games/mode with
shared seeded openings and zero rules divergences, against the baseline
in its **shipped UI configuration** (`doQuiesce = false`, no
transposition table, kingValue 2, and only the tablebase that actually
loaded in the shipped code — the legacy forced file; the shipped
unforced tablebase never parsed in the shipped reader, so the site
played unforced mode tablebase-free):

| Mode | W-L-D (new) | Score | Elo |
|---|---|---|---|
| Forced | 299-17-84 | 85.3% | ≈ +305 |
| Unforced | 253-25-122 | 78.5% | ≈ +225 |
| Pooled | 552-42-206 | 81.9% | **≈ +260** |

Against the stronger baseline *library* defaults (unlimited quiescence,
which the shipped UI never enabled), the forced-mode gap is +100 Elo
(194-82-124). Rough attribution from the per-change measurements:
quiescence repair + `quiesceDepth 1` ≈ +170/+120, learned eval terms
≈ +90-110 combined, tablebase handling ≈ +30 forced plus unblocking
unforced entirely; the correctness fixes (TT, killer, alpha-beta decay,
binary search) contribute reliability more than raw Elo.

### Incremental Zobrist hashing (measured honestly)

The board hash is maintained incrementally through every mutation path,
making `hashBase()` O(1): the primitive is 30× faster (136ns → 4.5ns),
but make/undo pays +22% for the bookkeeping and whole depth-4/5
searches net only **~2% faster** — move generation and eval dominate
node cost, not hashing. Kept anyway: strictly non-negative, verified by
an oracle test against from-scratch recomputation at every step of
random play, and it makes the per-node hash reads of the TT and
repetition check free at the margin.

### Adopted: eval dither raised to 0.003 (`Search.evalDither`)

Uniform ±d/2 noise on each leaf eval; it sits above the `valueDecay`
tie-break scale (~10⁻⁵) and below the learned eval terms. The original
0.001 existed for game variety; scanning higher values vs 0.001
(depth 4, 120/mode, forced/unforced) gave 0.003 → 52.5%/56.3%,
0.01 → 54.2%/46.3%, 0.03 → 49.2%/51.2%, and the 400 games/mode
confirmation of 0.003 came back **53.6% / 54.8% ± 4.9** (~54.2% ± 3.5
pooled, ≈ +29 Elo) — positive in both modes at scan and confirmation,
the standing adoption bar. The plausible mechanism is the Beal effect:
small random noise at fixed depth implicitly rewards mobility (more
continuations, more chances for a good max), and 0.003 collects that
bonus while staying below the scale where it out-shouts the learned
terms. Two robustness notes: even 0.03 — 30× the original — measured
only flat-to-mixed, so the knob is forgiving; and the scan curve alone
looked like noise (non-monotone), making this the second feature (after
king centralization) whose verdict came from the confirmation stage
rather than the scan. Reproduce with:

```sh
node arena.js --a new --b new --opts-a evalDither=0.003 --opts-b evalDither=0.001 --games 400
```

### Evaluation tuning protocol

Eval parameters are learned, not assumed: scan candidates head-to-head via
the arena (`--opts-a`/`--opts-b`) with shared seeded openings in both forced
modes, then confirm the winner with a large fast-game sample. The original
standing protocol tested at **depth 4** — the early experiments below ran
extra confirmations at depths 5-6, and the deeper runs matched the depth-4
verdict in direction every single time, so they were dropped as not worth
their cost. **Since the UI switched to node-budget levels, the standing
protocol player is `nodeLimit=2000, maxDepth=32`** (the measured depth-4
equivalent), so features are validated under the search dynamics production
actually uses (iterative deepening, killer move, budget stops); results
below predate the switch and were measured at fixed depth 4. Known blind
spot of both protocols: node budgets count nodes, not milliseconds, so a
per-node-expensive eval term's wall cost is invisible — `--max-seconds`
runs remain the tool for pricing that when it matters.

### Learned king value

The evaluation's king weight (originally a hardcoded 2.0× a pawn) is now
`Search.kingValue`, tuned by arena self-play rather than assumed. Head-to-head
vs 2.0 with shared seeded openings, both modes:

| K | depth 4 (120/mode) | K | depth 4 |
|---|---|---|---|
| 1.10 | 62.1% / 55.0% | 2.50 | 40.4% / 45.4% |
| 1.25 | 59.2% / 57.9% | 3.00 | 40.0% / 43.3% |
| 1.50 | 60.8% / 51.2% | | |
| 1.75 | 57.1% / 54.2% | | |

Every candidate below 2.0 won; every candidate above lost. The adopted value
**1.4** (the checkers-literature ballpark) scored 54.4%/53.3% over 400 fast
games per mode (depth 4) and held at 53.5%/52.5% in slow games (depth 6,
100/mode) — pooled 53.7% ± 3.1 over 1000 games. Reproduce with:

```sh
node arena.js --a new --b new --opts-a kingValue=1.4 --opts-b kingValue=2 --games 400
```

### Rejected: pawn-advancement bonus

`Search.rankValue` (a pawn counts `1 + w × forwardRank` material units) was
tested the same way and **rejected — it loses at every weight tried**:

| w/rank | depth 4, 120/mode (forced / unforced) |
|---|---|
| 0.005 | 50.0% / 47.5% |
| 0.01 | 45.4% / 47.1% |
| 0.02 | 43.3% / 49.2% |
| 0.04 | 40.8% / 41.7% |

Depth-5 confirmation of the least-bad candidate (0.005, 100/mode): 47.0% /
49.5%. Draw rates did not drop either. Plausible reading: in checkers,
advanced unsupported pawns are liabilities (they concede favorable trades and
abandon the back row), and the search already finds kinging plans tactically
within its horizon — so a blanket advancement gradient pushes pawns into
danger without buying anything. The parameter was retest-checked and then
**removed from the code**; these measurements are its record.

### Rejected: pawn-support bonus

`Search.supportValue` (per friendly piece diagonally behind a pawn, i.e. a
capture-safety proxy) and `Search.homeRowFullSupport` (whether an unjumpable
back-row pawn counts as 2 supports) were tested and **rejected**. The natural
variant was flat at small weights and harmful at 0.1/support (39.2% / 35.0%).
The full-home variant looked promising (53.0% ± 3.5 vs no-support over 800
games at 0.025) — but disentangling showed the gain was leaked back-row
value, not support: at equal back-row totals the support term **lost** to a
plain back-row raise (45.8% / 44.6%), and the raise itself was neutral vs
the adopted 0.1 (50.8% / 51.7%). Emerging pattern across experiments: eval
features earn their keep only by pricing what search *cannot* see within its
horizon (back-row → kinging prevention, long-horizon: adopted) — features
that proxy what quiescence already resolves exactly (capture safety) or what
the search finds tactically (advancement → kinging) add bias without
information. Both parameters were **removed from the code** after a final
review; these measurements are their record.

### Rejected decisively: explicit mobility (`mobilityValue`, removed)

The dither adoption suggested pricing mobility explicitly (the Beal
effect is implicit mobility). A mover-relative per-legal-move bonus —
free to compute, since the move list already exists at every eval
site — was scanned vs 0 (depth 4, 120/mode, forced/unforced) and
produced the cleanest downward dose-response of any experiment:
0.002 → 50.4%/52.1%, 0.005 → **37.1%/36.7%**, 0.01 → **19.2%/31.3%**.
Rejected without confirmation and removed.

The autopsy is instructive: symmetric zero-mean dither harvests the
mobility signal *statistically* without biasing any comparison, but an
explicit mover-relative term is a systematic bias whose sign depends
on whose turn the leaf lands on — and with quiescence extending some
lines and not others, sibling lines are compared at different leaf
parities, so the term injects parity noise instead of information.
Forced-jump positions also invert it (a winning capture position
reports one legal move). Slide mobility in this engine is best left to
the dither, which collects the benefit without the bias — but the
capture half of the idea survived, see the next section.

### Adopted: capture-threat bonus (`Search.captureThreatValue = 0.03`)

The refined survivor of the mobility experiment, per review: weight
captures up and slides to zero. The mover gets 0.03 per available jump
at eval time (counted from the already-generated move list — jumps
sort first — so it costs no extra move generation). Available jumps
signal material about to be won, exactly at the leaves where the
quiescence budget ran out, making the term a cheap proxy for the
extension the search could not afford; it also un-inverts the
one-winning-capture positions the slide count punished. Scan vs 0
(depth 4, 120/mode, forced/unforced) was single-peaked: 0.01 →
52.5%/56.3%, **0.03 → 55.0%/56.7%**, 0.08 → 35.8%/35.4% (loud enough
to out-shout material, the parity bias takes over). Confirmation of
0.03 at 400 games/mode: **57.3% / 57.3% ± 4.8** (+51 Elo in both
modes) — the strongest confirmed eval term since the back-row bonus.
Reproduce with:

```sh
node arena.js --a new --b new --opts-a captureThreatValue=0.03 --opts-b captureThreatValue=0 --games 400
```

### Adopted: back-row pawn bonus (`Search.homeRowValue = 0.1`)

The mirror image of the rejected advancement bonus — a pawn still guarding
its back row counts `1 + 0.1` material units, pricing kinging *prevention*,
which the eval otherwise cannot see beyond the search horizon. Every
candidate won its scan (depth 4, 120/mode, forced/unforced):

| bonus | score | bonus | score |
|---|---|---|---|
| 0.05 | 57.5% / 59.6% | 0.2 | 54.2% / 59.2% |
| **0.1** | **63.3% / 60.0%** | 0.4 | 57.5% / 63.3% |

Confirmations of 0.1: 400 fast games/mode at depth 4 → 59.1% / 59.8%
(59.4% ± 3.4 pooled); 100 slow games/mode at depth 5 → 55.0% / 51.5%.
Joint stability: with the bonus active, kingValue 1.2 and 1.6 both fail to
beat 1.4 (≈50%), so the adopted pair is (kingValue 1.4, homeRowValue 0.1).
Reproduce with:

```sh
node arena.js --a new --b new --opts-a homeRowValue=0.1 --opts-b homeRowValue=0 --games 400
```

Refinement: the bonus applies **only while the opponent still has pawns to
king** — guarding the back row against a kings-only opponent prevents
nothing, and an unconditional bonus kept defenders home when they should run
for coronation. Adopted on that soundness argument plus non-losing evidence:
vs the unconditional version (`snapshots/after-homerow`) it scored 50.6% /
50.6% over 400 games/mode at depth 4 and 53.0% / 51.0% over 100/mode at
depth 5 — positive in all four cells (50.9% ± 2.9 pooled), with the effect
naturally concentrated in the rare kings-only endgames where it fires.

### Adopted: runaway pawn bonus (`Search.runawayValue = 0.2`)

A pawn is a *runaway* when its forward cone — every square any path to the
kinging row can pass through — contains no enemy piece. That is an
uncontested coronation sitting beyond the horizon, exactly what a
fixed-depth search cannot see; the bonus is a discount on the kinging gain
(kingValue − 1 = 0.4). The cone test is a snapshot approximation (enemies
can sidestep into the cone, kings can chase from behind), but the arena
prices the net effect. Scan vs 0 (depth 4, 120/mode, forced/unforced):

| bonus | score | bonus | score |
|---|---|---|---|
| 0.1 | 53.8% / 53.8% | 0.3 | 52.9% / 54.2% |
| **0.2** | **54.6% / 53.3%** | | |

Every candidate won both modes. Confirmation of 0.2: 400 games/mode at
depth 4 → 52.5% / 53.3% (± 4.9 each; 52.9% ± 3.5 pooled), and kingValue
1.4 re-verified as stable alongside it (1.2 and 1.6 both fail to beat it
with the bonus active). Cost: ×1.19 wall time at depth 4 on a midgame
position sample — the cone scans early-exit on the first enemy hit.

Graded variant (`runawayGraded=true` scaled the bonus by forwardRank/6,
pricing how *imminent* the coronation is): tested and **rejected**, then
removed from the code. The scan vs flat 0.2 looked mildly promising
(w=0.2 → 52.1% / 51.7%, w=0.3 → 52.1% / 52.9%, w=0.4 → 50.8% / 48.3%
over 120/mode), but the 400/mode confirmation of w=0.3 came back dead
flat: 50.2% / 49.3% ± 4.9. The likely reason: near-kinging runaways are
already inside the search horizon (grading adds nothing there), while
distant runaways — where the flat bonus does its work steering the
midgame — are exactly what grading zeroes out. Reproduce the flat
adoption with:

```sh
node arena.js --a new --b new --opts-a runawayValue=0.2 --opts-b runawayValue=0 --games 400
```

### Adopted after retest: king centralization (`Search.kingCenterValue = 0.05`)

Counts each king `kingValue + w × edgeDistance` (0–3 steps from the
nearest edge), pricing mobility and corner-trappability. A case study in
feature interaction: **rejected** when first tested (no candidate won
both modes — 0.02 → 54.2% / 46.3%, 0.05 → 50.4% / 50.8%, 0.1 → 50.8% /
49.2%), because at the time the engine still shuffled in
won-but-uncovered endgames, so any centralization edge dissipated into
adjudicated draws. After `repetitionDraws` shipped, a pre-removal retest
under current defaults flipped every cell positive: 0.05 → 52.9% /
55.8%, 0.1 → 56.3% / 50.4% (120/mode). Confirmation of 0.05: 400
games/mode → **55.1% / 51.0%** (± 4.9; 53.1% ± 3.5 pooled), with
kingValue 1.4 re-verified stable alongside it (1.2 and 1.6 lose all four
joint cells). The anti-shuffle rule makes the engine explore fresh
ground in uncovered king endgames; centralization tells it which fresh
ground pays. Reproduce with:

```sh
node arena.js --a new --b new --opts-a kingCenterValue=0.05 --opts-b kingCenterValue=0 --games 400
```

## Tablebase generation (the shipped tables are regenerated ≤4-piece v4)

The original site tablebases covered only **≤3 pieces** (proven by
enumeration accounting plus 575,360 3-kings-vs-1 probes: zero hits) and
misclassified deep decisive states as draws (BUGS.md #12).
`tools/generate-tablebase.js` rebuilds them from scratch by layered
retrograde analysis, using the engine itself for move generation (a shared
`Game` via a constructor backdoor, dense `tablebaseRank` ids, flat edge
arrays, and a compacting worklist):

```sh
node tools/generate-tablebase.js 4 forced end8Forced      # ~2.5-3 min
node tools/generate-tablebase.js 4 unforced end8Unforced
```

Proof of correctness before adopting: the generator reproduces the
originally shipped data **exactly** — 100.00% presence and zero value
mismatches across all 500,334 shipped entries in both modes
(`tools/verify-generator.js`; the only discrepancy classes are the
originals' own gaps: elimination terminals, non-canonical inflated
distances, and the ~141k deep wins dropped by their draw-threshold-bounded
generation). The 2-piece slice of that proof runs in the test suite on
every `npm test`.

The shipped ≤4-piece solve: 15.3M enumerated states per mode, 12,817,672
labeled base positions each (forced: 9,360,134 decisive + 3,457,538
draws; unforced: 9,309,216 + 3,508,456), 110 retrograde rounds over
52-61M edges, 19,062,288 bytes per file. Draws are explicit and exact
(clockless semantics: unlabeled after the retrograde fixpoint = provably
drawn), distances are canonical, and the deep wins the originals called
draws are decisive. Serve the files pre-compressed: they gzip to ~4.8 MB
each, which is the wire cost that made shipping 4-piece coverage
worthwhile (the 19 MB shows up only as decompressed memory).

Arena validation (depth 4, 400 games/mode, shared seeded openings, the
only difference being which tablebase each side probes): ≤4 scored
**54.8% forced** (169-131-100) vs the v3-era ≤3 data and was flat in
unforced mode (48.9%, 135-144-121) where games rarely reach the covered
region, with no alarms and no divergences. A compact ≤3 v4 build (651 KB,
`node tools/generate-tablebase.js 3 ...`) remains available for
size-constrained serving; it measured flat vs the v3-era tables (51.3% /
51.0%, matching coverage) and carries the same #12 fixes.

## Test coverage summary

- **Rules**: opening position, slides, jumps, forced-jump exclusivity,
  multi-jump continuation, crowning (including the crowning-ends-the-chain
  rule), king movement/backward capture, edge/no-wrap behavior, blocked-player
  loss, unforced-jump mode.
- **State machinery**: undo restores exact state and hash for every move type;
  Zobrist hash transposition-invariance; `copy`/`swapTurnCopy` independence;
  `movesSinceProgress` accounting.
- **Properties** (seeded, deterministic): 50 random self-play games with
  per-ply invariant checks and undo/redo verification; exhaustive
  checked-`makeMove` vs `getMoves()` equivalence over every square/offset pair
  across random game trajectories, in both jump modes.
- **Players**: random-player legality and determinism, playout semantics,
  search picks winning/safe captures, lost-position values, iterative
  deepening.
- **Tablebase reader**: synthetic round-trip, absent-hash behavior, the
  max-observed-checker-count heuristic, and validation of the shipped binary
  files.
