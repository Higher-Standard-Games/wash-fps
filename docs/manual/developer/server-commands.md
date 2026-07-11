# Server Commands

The dedicated server (`npm run net:server -- ...`) accepts admin commands at runtime via its TTY.

## Gameplay Cvars

Server-side tunables (defaults shown). Movement cvars live in `src/engine/movement/MovementVars.ts`.

### Fall damage

| Cvar | Default | Effect |
|------|--------:|--------|
| `sv_falldamage` | `1` | Master toggle (0 = off) |
| `sv_falldamage_min` | `256` | Drop (map units) where damage starts |
| `sv_falldamage_full` | `384` | Drop where the ramp reaches 100 / crush point (all armor + 1 HP) |
| `sv_falldamage_fatal` | `512` | Drop that is instantly fatal (self-frag) |
| `sv_falldamage_crouchsoften` | `64` | Effective drop reduction when landing crouched |

A server-console `[FallDamage]` line logs the raw vs effective drop and the band on every landing — handy for tuning.

### Teleporters

Exit-velocity policy is a movement **config** value (deterministic; deliberately not a live cvar, so demo re-simulation stays exact). The default redirects the player's full 3D momentum along the exit yaw (Warsow); an alternate mode uses a fixed Q3 exit speed. See `MovementConfig.teleportSpeedMode` / `teleportExitSpeed`.

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
