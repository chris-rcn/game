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
| `end8Forced`, `end8Unforced` | Endgame tablebases in the v3 "CHFT" headered format (converted from the site originals; 11% and 8x smaller respectively) |
| `testdata/end8Forced.legacy`, `testdata/end8Unforced.padded` | The original site downloads, kept as fixtures for the legacy 9-byte and capacity-padded 8-byte reader paths |
| `tools/convert-tablebase.js` | Converts any supported tablebase format to v3 (verifies entry-for-entry before writing) |

Tablebase v3 format: 16-byte header (`CHFT` magic, u32 version, u32 entryCount,
u32 flags with bit 0 = forced-jumps mode) followed by exact-sized arrays
`u32 h0[n] | u16 (h1>>>16)[n] | u8 (h1&0xFF)[n] | u8 resultAndDist[n]`.
It combines the legacy format's exact sizing with the newer format's leaner
8-byte entries, and the header makes detection unambiguous, catches truncation,
and lets the UI refuse a tablebase generated for the wrong rules mode.
`ResultList2` reads all three formats.

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

### Search characteristics (measured)

At depth 4 with current defaults: quiescence is worth **+219 Elo forced /
+163 unforced** at equal depth, versus **+165 / +153** for one extra ply
without it — and head-to-head, d4-with-quiescence beats d5-without by
+72 / +23. Cost on identical position sets: quiescence multiplies wall time
by ×2.4 (forced) and ×4.3 (unforced); an extra ply costs ×2.3 / ×3.1. So in
forced mode quiescence delivers more strength than a ply at the same price;
in unforced mode raw depth is marginally more time-efficient but quiescence
still wins at equal depth. Note: the shipped UI runs `doQuiesce = false` —
a difficulty decision worth revisiting, since it forfeits ~200 Elo.

`doQuiesce` was converted to a graded budget, `Search.quiesceDepth`: the
number of plies past the horizon the search may extend while a capture is
pending (or the move is forced). 0 ≡ the old `false`, Infinity (the default)
≡ the old `true`, and intermediate values are new strength rungs. Measured
ladder at depth 4 (forced/unforced, warmed best-of-3 costs): qd0→qd1
**+172/+117 Elo** for ×1.67/×1.88 time; qd1→qd2 +76/+19 for ×1.20/×1.27;
qd2→∞ +60/+14 for ×1.11/×1.56. The first budget ply delivers +232/+129 Elo
per time-doubling — better than a full ply (+140/+93) in **both** modes,
since it buys exactly the refutation one ply past the horizon. (Earlier
×2.4/×4.3 full-quiescence cost figures were JIT-warmup-inflated; warmed
costs are ×2.2/×3.7.) The UI keeps its handicap as `quiesceDepth = 0` and
can now build level rungs from (depth, quiesceDepth) pairs.

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
note: the UI's level ladder is linear in depth but wildly nonlinear in
strength (level 1→2 ≈ 1000 Elo, level 4→5 ≈ 160).

### Evaluation tuning protocol

Eval parameters are learned, not assumed: scan candidates head-to-head via
the arena (`--opts-a`/`--opts-b`) with shared seeded openings in both forced
modes, then confirm the winner with a large fast-game sample. **Testing at
depth 4 is the standing protocol** — the early experiments below ran extra
confirmations at depths 5-6, and the deeper runs matched the depth-4 verdict
in direction every single time, so they were dropped as not worth their cost.

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
danger without buying anything. The knob stays (default 0, exactly the old
eval) in case a future, deeper-search retest disagrees.

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
information. Both knobs stay, default off.

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
