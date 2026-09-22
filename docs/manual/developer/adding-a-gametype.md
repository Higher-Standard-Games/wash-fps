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
- Worked example: a minimum-viable "First To 5" gametype

For now, see `src/games/fps/server/gametypes/Duel.ts` for the smallest existing
example, and `Amphi.ts` for the smallest round-based one.

## Registering one

A gametype class is not enough on its own; Amphi needed all four of these:

1. Export it from `server/gametypes/index.ts`.
2. Add its keyword to the constructor mapping in
   `src/cli/headless-netserver-v2.ts`, which is what a dedicated server picks
   from — including any aliases, since unknown keywords fall through to
   Deathmatch rather than failing.
3. Add any alias to `normalizeGametype` in `client/FpsMapLauncher.ts`, which
   maps what a player types at `map <name> <gametype>` onto the lobby's ids.
4. Add it to `GAMETYPE_SHELLS` in the engine repo's `src/lobby/LobbyServer.ts`,
   with its player count, team flag and team names, or the lobby will never
   offer it. The lobby only advertises a mode whose maps are installed, so its
   maps also need entries in `config/maps.json`.
