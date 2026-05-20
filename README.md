# Washiki Washoi

Arena FPS built on the [SHAG Engine](https://github.com/Higher-Standard-Games/shag). Q3/Warsow-style movement, server-authoritative combat, dedicated servers, lobby matchmaking, bots, demos.

This repository is a **git submodule** that lives at `src/games/fps/` inside the SHAG engine repo. It can't be built or run in isolation — it always runs inside the engine.

## Manual

Full documentation lives in [`docs/manual/`](./docs/manual/):

- **[Introduction](./docs/manual/introduction/)** — what's in, what's coming
- **[Getting Started](./docs/manual/getting-started/)** — setup, first run, dedicated server, bots
- **[Player Manual](./docs/manual/player/)** — controls, movement, weapons, pickups, HUD
- **[Gametypes](./docs/manual/gametypes/)** — Duel, Deathmatch, Team Deathmatch
- **[Multiplayer](./docs/manual/multiplayer/)** — lobby flow, connecting, demos
- **[Developer](./docs/manual/developer/)** — architecture, adding weapons + gametypes
- **[Tools](./docs/manual/tools/)** — Bot Intelligence Server, cinematic demo player
- **[FAQ](./docs/manual/faq/)** — troubleshooting

## Quick Start

Clone the engine repo with this submodule:

```bash
git clone --recursive https://github.com/Higher-Standard-Games/shag.git
cd shag
npm install
npm run dev
```

Open `http://localhost:5173` and press the lobby's **Play** button.

For developer flows (one-keystroke local match, dedicated server, bot AI), read [Getting Started](./docs/manual/getting-started/).

## Game Data

PK3 files (maps, textures, models, sounds) are **not** in this repo or the engine repo. Drop them under `public/data/` in the engine repo. The directory is gitignored — each developer manages their own data.

## License

MIT
