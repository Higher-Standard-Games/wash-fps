# Getting Started

::: tip Just want to play?
**Play Washiki Washoi in your browser at [washoi.net](https://washoi.net)**: nothing to install. Start with [Your first match](../player/first-match.md).

This guide is for modders and developers who want to run the game locally from its source code.
:::

Washiki Washoi runs as a git submodule under `src/games/fps/` inside the SHAG engine repo. The engine handles BSP / PK3 / shaders / rendering / physics; this submodule is the game on top.

## Requirements

- **Node.js 22.13+** with built-in `node:sqlite` enabled for the lobby. Tested
  with Node 24.21.0. [Node's SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
  records when the module became available without an extra runtime flag.
- **Git** with submodule support
- A modern WebGL2-capable browser; WebGPU is also available on supported setups

## Setup

### Clone the engine + this submodule together

```bash
git clone --recursive https://github.com/Higher-Standard-Games/shag.git
cd shag
npm install
```

### Add to an existing engine clone

```bash
git submodule update --init --recursive
```

### Game data

PK3 files (maps, textures, models, sounds) are **not** in this repo or the engine repo. Drop them into `public/data/` in the engine repo root:

| Package in `public/data/` | Purpose |
| --- | --- |
| `map_washoi_dm2.pk3` | Example installed map archive |
| `player_model_vanguard.pk3` | Player models and animation clips |
| Other `*.pk3` packages | Shared textures, sounds and other game data |

This directory is gitignored — each developer downloads or builds their own game data.

Map loading uses the PK3 index rather than searching for loose BSP files. After
adding packages, run `npm run tools:pk3-index`; restart the lobby so its installed
map list is refreshed. See [Maps](../gametypes/maps.md).

## First Run

```powershell
# In the engine repo root (PowerShell)
npm --prefix src/games/fps run dev
```

Washoi owns `client/main.ts`, `index.html` and `browser.json`. SHAG supplies the
renderer and engine services. The game package's commands select Washoi
automatically, including `npm --prefix src/games/fps run build`. They run from
the assembled root so media, storage and output paths keep the same meaning.
Inside `src/games/fps`, the shorter `npm run dev` and `npm run build` also work.
Install dependencies only at the engine root; the game package supplies commands
and does not install another Babylon or TensorFlow dependency tree.

The engine's own `npm run dev` uses `SHAG_APP` or `.shag-application.json`;
set `SHAG_APP=engine` there to open its example instead. Media remains under
the engine's `public/data/` directory. The tracked submodule still exists during
the repository split; the checkout commands above remain applicable until cutover.

Run `npm --prefix src/games/fps run lobby:server` in another terminal for a local lobby. Open
`http://localhost:3000`, choose **Play**, a mode and Public or Private, then enter
a room and ready up. Run `npm --prefix src/games/fps run bot:server` as well to add bots; a room with a bot is private.
See [Your First Match](../player/first-match.md).

For the developer flow with a one-keystroke server-backed map launch:

```
# In a separate terminal
npm --prefix src/games/fps run lobby:server

# Then in the in-game console (press the backquote key):
developer 1; map washoi_dm2 duel
```

See the engine's Map Launching Guide (`docs/manual/guides/map-launching.md` in the engine repo) for the full developer flow.

## Dedicated Server

Washoi supplies a headless dedicated-server launcher that runs its `GameServer`
using SHAG's reusable server services:

```bash
npm --prefix src/games/fps run net:server -- --map washoi_dm2 --port 7777 --gametype duel
```

Common flags (the full list, including `--name`, `--tickrate`, `--snapshotrate`, `--single-match` and TLS options, is in [Server Commands](../developer/server-commands.md#server-launch-options)):

| Flag | Default | Notes |
|------|---------|-------|
| `--map` | `washoi_dm2` | Map name (must exist in `public/data/`) |
| `--port` | `7777` | WebSocket port |
| `--gametype` | `Deathmatch` | Release modes: `Deathmatch` (`ffa`), `Duel` (`1v1`), `Amphi`, `SnD` (`bomb`) |
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
npm --prefix src/games/fps run bot:server
```

See [Tools → Bot Server](../tools/bot-server.md) for the full bot lifecycle, difficulty presets, and training pipeline.

## Preview this manual

From the engine repository root:

```bash
npm --prefix src/games/fps run docs:dev
npm --prefix src/games/fps run docs:build
npm --prefix src/games/fps run docs:preview
```

The game manual has its own VitePress config and bundled fonts. The engine's
`docs:dev` / `docs:build` scripts serve the engine manual instead.

## Next

- [Troubleshooting Setup](./troubleshooting.md) — lobby offline, missing maps, bots that won't join
- [Project Structure](./project-structure.md) — what lives where in this submodule
- [Player Manual](../player/) — controls, movement, weapons
- [Multiplayer](../multiplayer/) — lobby flow + console networking commands
