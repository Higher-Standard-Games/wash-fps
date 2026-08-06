# Washiki Washoi — Manual

**Washiki Washoi** is the reference arena FPS built on the [SHAG Engine](https://github.com/Higher-Standard-Games/shag). Q3/Warsow-style movement, server-authoritative combat, dedicated servers, lobby matchmaking, bots, demos.

This manual covers the game. The engine that runs underneath it has its own manual in the SHAG repo under `docs/manual/`.

---

## What's Here

| Section | For |
|---------|-----|
| [Introduction](./introduction/) | What the game is and what shipped |
| [Getting Started](./getting-started/) | Setup, first run, dedicated server |
| [Player Manual](./player/) | Controls, movement, weapons, pickups, HUD |
| [Gametypes](./gametypes/) | Duel, Deathmatch, Team Deathmatch, Search & Destroy |
| [Multiplayer](./multiplayer/) | Lobby flow, connecting, demos |
| [Developer](./developer/) | Architecture, adding weapons + gametypes, server commands |
| [Tools](./tools/) | Bot Intelligence Server, cinematic demo player |
| [FAQ](./faq/) | Troubleshooting |

---

## Quick Start

```bash
# In the SHAG engine repo (this is a submodule under src/games/fps/)
npm install
npm run dev
# Open http://localhost:5173, press the lobby's "Play" button
```

For developer flows (running a local dedicated server, console commands, bot AI), see [Getting Started](./getting-started/).
