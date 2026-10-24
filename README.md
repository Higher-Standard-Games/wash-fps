# Washiki Washoi

Arena FPS built on the [SHAG Engine](https://github.com/Higher-Standard-Games/shag). Q3/Warsow-style movement, server-authoritative combat, dedicated servers, lobby matchmaking, bots, demos.

This repository is a **git submodule** that lives at `src/games/fps/` inside the SHAG engine repo. It can't be built or run in isolation — it always runs inside the engine.

## Manual

Full documentation lives in [`docs/manual/`](./docs/manual/):

- **[Introduction](./docs/manual/introduction/)** — what's in, what's coming
- **[Getting Started](./docs/manual/getting-started/)** — setup, first run, dedicated server, bots
- **[Player Manual](./docs/manual/player/)** — controls, movement, weapons, pickups, HUD
- **[Gametypes](./docs/manual/gametypes/)** — Duel, Amphi, Deathmatch, Team Deathmatch, Search & Destroy
- **[Multiplayer](./docs/manual/multiplayer/)** — lobby, rooms and accounts, connecting, chat, demos
- **[Developer](./docs/manual/developer/)** — architecture, adding weapons + gametypes
- **[Tools](./docs/manual/tools/)** — Bot Intelligence Server, bot training, cinematic demo player
- **[FAQ](./docs/manual/faq/)** — troubleshooting

## Quick Start

Clone the engine repo with this submodule:

```bash
git clone --recursive https://github.com/Higher-Standard-Games/shag.git
cd shag
npm install
npm --prefix src/games/fps run dev
```

Open `http://localhost:3000` and press the lobby's **Play** button.

For local matches, start the lobby in another terminal at the engine root:

```bash
npm --prefix src/games/fps run lobby:server
```

For private-room bot invites, start `npm --prefix src/games/fps run bot:server`
in a third terminal. The lobby starts match servers as needed. For direct
connections, use `npm --prefix src/games/fps run net:server` instead.

The private game package owns these commands. From the engine root use
`npm --prefix src/games/fps run <command>`; from this folder use
`npm run <command>`. The launcher selects Washoi and runs with the engine root
as its working directory, preserving media, server-data and artifact paths.
Install dependencies once at the engine root; no game-local install is needed.

For developer flows (one-keystroke local match, dedicated server, bot AI), read [Getting Started](./docs/manual/getting-started/).

## Game Data

PK3 files (maps, textures, models, sounds) are **not** in this repo or the engine repo. Drop them under `public/data/` in the engine repo. The directory is gitignored — each developer manages their own data.

## License

MIT
