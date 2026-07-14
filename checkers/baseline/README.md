# baseline/ — frozen engine snapshot

This is a byte-for-byte copy of `common.js`, `checkers.js` and `players.js` as
mirrored from `chf-checkers.s3-website-us-west-2.amazonaws.com` (the "old"
version, bugs and all — see `../BUGS.md`).

**Do not edit these files.** Bug fixes go in the root copies; `arena.js` plays
the root ("new") version against this snapshot to measure the effect of each
change. The two copies are loaded as independent Node modules, so their
module-level state (`jumpsAreForced`, seeded RNG) does not interact.
