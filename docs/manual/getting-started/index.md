# Getting Started

Washiki Washoi runs as a git submodule under `src/games/fps/` inside the SHAG engine repo. The engine handles BSP / PK3 / shaders / rendering / physics; this submodule is the game on top.

## Requirements

- **Node.js 18+** (22 LTS recommended)
- **Git** with submodule support
- A modern WebGL2-capable browser

## Setup

### Clone the engine + this submodule together

```bash
git clone --recursive https://github.com/Higher-Standard-Games/shag.git
cd shag
npm install
```

### Add to an existing engine clone

```bash
git submodule add <fps-repo-url> src/games/fps
git submodule update --init
```

### Game data

PK3 files (maps, textures, models, sounds) are **not** in this repo or the engine repo. Drop them into `public/data/` in the engine repo root:

```
public/data/
├── maps/         # .bsp and .map files
├── textures/
├── music/
└── *.pk3
```

This directory is gitignored — each developer downloads or builds their own game data.

## First Run

```bash
# In the engine repo root
npm run dev
```

Open `http://localhost:5173`. You should see the lobby UI. Press **Play** to enter a match.

For the developer flow with a one-keystroke server-backed map launch:

```
# In a separate terminal
npm run lobby:server

# Then in the in-game console (press the backquote key):
map wdm2 duel
```

See the engine's Map Launching Guide (`docs/manual/guides/map-launching.md` in the engine repo) for the full developer flow.

## Dedicated Server

The engine ships a headless dedicated server that runs this game's `GameServer` orchestrator:

```bash
npm run net:server -- --map wdm2 --port 7777 --gametype duel
```

Common flags (the full list, including `--name`, `--tickrate`, `--snapshotrate`, `--single-match` and TLS options, is in [Server Commands](../developer/server-commands.md#server-launch-options)):

| Flag | Default | Notes |
|------|---------|-------|
| `--map` | `wdm7` | Map name (must exist in `public/data/`) |
| `--port` | `7777` | WebSocket port |
| `--gametype` | `Deathmatch` | `Deathmatch`, `TeamDeathmatch` (`tdm`), `Duel` (`1v1`), `Amphi`, `SnD` (`bomb`) |
| `--max` | `16` | Max clients |
| `--shutdown` | off | Auto-exit when all clients disconnect |

Type `spawn_bots 4` in the server's terminal to add four simple bots.

Connect to it from the in-game console:

```
connect ws://localhost:7777
```

## Bot Intelligence Server

Bots run as a separate Node.js process and connect to game servers as real WebSocket clients — at the protocol level they are indistinguishable from human players.

```bash
npm run bot:server
```

See [Tools → Bot Server](../tools/bot-server.md) for the full bot lifecycle, difficulty presets, and training pipeline.

## Next

- [Troubleshooting Setup](./troubleshooting.md) — lobby offline, missing maps, bots that won't join
- [Project Structure](./project-structure.md) — what lives where in this submodule
- [Player Manual](../player/) — controls, movement, weapons
- [Multiplayer](../multiplayer/) — lobby flow + console networking commands
