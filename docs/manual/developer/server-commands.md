# Server Commands

The dedicated server (`npm run net:server -- ...`) accepts admin commands at runtime via its TTY.

## TODO

This page is a stub. Full coverage to come:

- The server CLI prompt + how it differs from the in-game console
- Match-control commands: `start`, `restart`, `endmatch`
- Player-control commands: `kick`, `mute`, `slap`
- Bot-control commands: `bot add`, `bot remove`, `bot difficulty`
- Map-rotation: `map next`, `nextmap`
- Logging level + verbosity flags
- Per-gametype overrides at launch time

For now, the server's source of truth is `src/games/fps/server/GameServer.ts` and the headless wrapper at `src/cli/headless-netserver-v2.ts` (in the engine repo, not this submodule).
