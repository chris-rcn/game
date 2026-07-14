# Working rules for this repository

## Reporting experiment results (MANDATORY)

Every experiment (arena scan, confirmation run, benchmark, timing
measurement) that completes during a turn MUST be summarized at the TOP
of that turn's final message, before any description of actions taken:

1. Lead with a "Results" block: what was compared, the numbers (as a
   table when there are 2+ cells), and the verdict (adopt / reject /
   inconclusive-next-step).
2. Only after the results block, describe what was done about it
   (code changes, commits, next runs).
3. Never leave results stated only in text between tool calls — that
   text is unreliable; the final message is the record.
4. If a background run completes and its results have not yet been
   summarized, summarizing them takes priority over starting new work.

## Layout

The checkers project (engine, UI, tests, arena, tools, tablebases)
lives entirely under `checkers/`; run `npm test` and `node arena.js`
from that directory. The repo root holds only this file and a redirect
index.html.

## Experiment record

Every measurement also goes into checkers/README.md (adopted AND rejected, with
reproduce commands where the options still exist) in the same turn the
verdict lands. Commit messages are not a substitute.

## Tuning protocol

Scan (120 games/mode) then confirm (400 games/mode), both modes, via
checkers/arena.js. Standard player since the node-budget switch:
`nodeLimit=2000, maxDepth=32`. Adoption bar: positive in both modes at
confirmation.
