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

## Dedicated Server Console

The dedicated server reads commands from its terminal (stdin). In this version there are only three:

| Command | Effect |
|---------|--------|
| `spawn_bots <N>` (alias `bots`) | Spawn `N` bot entities (1–32; default 3) at spawn points |
| `status` | Print the map and tick rate |
| `help` | List the commands |

Anything else prints `Unknown command`. There is no `kick`, `restart`, `endmatch` or map-rotation command; matches are started and ended through the lobby, or by restarting the process. A lobby-spawned server also receives one internal command from the lobby, used to seat a player who drops into a running match. It isn't meant to be typed by hand.

Bots spawned this way are not the Bot Intelligence Server's bots. For bots that behave like players and have difficulty tiers, run [`npm run bot:server`](../tools/bot-server.md), or add bots from a lobby room.

## Server Launch Options

```bash
npm run net:server -- --map wdm2 --gametype duel --port 7777
```

| Flag | Default | Notes |
|------|---------|-------|
| `--map` | `wdm7` | Map name (must exist in `public/data/`) |
| `--gametype`, `-g` | `Deathmatch` | Release modes: `Deathmatch` (`ffa`), `Duel` (`1v1`), `Amphi`, `SnD` (`bomb`, `searchanddestroy`). Unknown values fall back to Deathmatch |
| `--port` | `7777` | WebSocket port |
| `--name`, `--hostname` | `SHAG Server v2` | Server name |
| `--max`, `--maxclients` | `16` | Max clients |
| `--tickrate` | `125` | Simulation rate in Hz |
| `--snapshotrate` | `60` | Snapshot rate in Hz |
| `--game` | `./game` | Game data path |
| `--cert`, `--key` | `./certs/localhost*.pem` | TLS certificate and key (or `SHAG_GAME_CERT_PATH` / `SHAG_GAME_KEY_PATH`) |
| `--shutdown` | off | Exit when all clients disconnect |
| `--single-match` | off | One match per server: the post-game is final, players return to the lobby, bots are released and the process exits. This is how the lobby runs matches |

### Match pacing overrides

Three environment variables, read once at boot, change a gametype's limits. They are useful for short test matches and apply to every gametype (see [Deathmatch](../gametypes/deathmatch.md#tuning-for-development)):

| Variable | Meaning |
|----------|---------|
| `SHAG_TIMELIMIT` | Bare number = **minutes**; `90s` for seconds |
| `SHAG_SCORELIMIT` | Frag or round limit |
| `SHAG_WARMUP` | Bare number = **seconds**; `2m` for minutes |
| `SHAG_DEBUG` | Extra diagnostics, as a comma-separated list of topics or `all`. Off by default; see below |

### Server diagnostics

The server console prints lifecycle events (joins, match start and end, demos saved) and problems. Anything that would print per tick, per hit or per message is off unless you ask for it:

```bash
SHAG_DEBUG=phys,kb npm run server
```

| Topic | Prints |
|-------|--------|
| `phys` | One line per player per second from the movement code |
| `kb` | Knockback applied, and the position after that tick |
| `falldamage` | Every landing, with the drop and its damage band |
| `input` | A sample of the input buttons every 200 commands |
| `perf` | Snapshot encode cost every 100 ticks |
| `discharge` | A shot fired into water |

## Game Console Commands

Registered by this game at boot (`console/commands/`), used from the in-game console (press **`** the backquote key):

| Command | What it does |
|---------|--------------|
| `connect <url>` / `disconnect` | Join or leave a game server; see [Connecting](../multiplayer/connecting.md) |
| `demo`, `demolist`, `demoplay` | Load, list and play demos; see [Demos](../multiplayer/demos.md) |
| `loadout <primary> <secondary>` | Pick your Search & Destroy or Amphi kit for the next round |
| `water [sample\|splash\|ripple\|render]` | Inspect liquid state at the camera and the player |
| `netsim <test\|spawn\|tick\|state\|input>` | Network simulation testing |
| `pickup_audit` | Audit client/server pickup active-set reconciliation |
| `camera_audit` | Report what owns the camera and what is rolling the view |

The engine adds its own (`map`, `bind`, and others); see the engine's command reference.
