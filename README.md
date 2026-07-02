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
node arena.js --opts-a doQuiesce=false                # asymmetric feature comparison
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
