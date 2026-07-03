# snapshots/ — intermediate engine versions for the arena

`baseline/` stays frozen at the original mirrored code forever (the cumulative
anchor). Directories here capture intermediate states so a single fix can be
measured in isolation instead of conflated with everything before it.

Take a snapshot of the state just before starting a fix, straight from git:

```sh
mkdir -p snapshots/<name>
for f in common.js checkers.js players.js; do
  git show <commit>:$f > snapshots/<name>/$f
done
node arena.js --b snapshots/<name> ...
```

| Snapshot | Taken from | Contains |
|---|---|---|
| `after-tt-fix` | commit `12651a0` | quiescence fix (#11) + transposition-table fix (#4); pre killer-move fix (#5) |
| `after-killer-fix` | commit `277f66a` | above + killer/forced-move fix (#5); pre alpha-beta/decay fix (#7) |
| `after-ab-fix` | commit `01a6f86` | above + alpha-beta/decay fix (#7); pre binarySearch fix (#1) |
| `after-homerow` | commit `b6e4c54` | all fixes + learned kingValue 1.4 + unconditional homeRowValue 0.1; pre opponent-has-pawns condition |
| `after-eval-tuning` | commit `09d2db7` | full eval tuning (support rejection); pre tablebase distance-decay fix |
