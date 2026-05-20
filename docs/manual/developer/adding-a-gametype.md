# Adding a Gametype

A new gametype is a class that extends `BaseGametype` and slots into the `GametypeController` framework.

## TODO

This page is a stub. Full coverage to come:

- `BaseGametype` interface walk-through
- Win/loss condition hooks
- Spawn point selection override
- Score event handlers (`onPlayerKill`, `onPlayerDeath`)
- Team management (for team-based gametypes)
- `MatchState` lifecycle (`waiting → warmup → playing → ended`)
- Gametype registration: add the keyword alias map to `FpsMapLauncher.normalizeGametype` and the constructor mapping in `headless-netserver-v2.ts`
- Worked example: a minimum-viable "First To 5" gametype

For now, see `src/games/fps/server/gametypes/Duel.ts` for the smallest existing example.
