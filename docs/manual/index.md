---
layout: home
hero:
  name: Washiki Washoi
  text: Learn the map. Own the fight.
  tagline: The player manual for fast movement, eight weapons, four lobby modes and your next match.
  actions:
    - theme: brand
      text: Your first match
      link: /player/first-match
    - theme: alt
      text: Controls & settings
      link: /player/settings
    - theme: alt
      text: Run the game locally
      link: /getting-started/
features:
  - title: Move with purpose
    details: Strafe jump, build speed and learn the routes that put you ahead.
    link: /player/movement
  - title: Pick your fight
    details: Duel, Amphi, FFA and Search & Destroy. Learn the rules before you ready up.
    link: /gametypes/
  - title: Keep your record
    details: Public and private ladders, skill ratings, match history and a portable account key.
    link: /multiplayer/lobby
  - title: Watch and learn
    details: Follow a player's view or watch a highlight reel from a recorded match.
    link: /multiplayer/demos
---

## The game manual

**Washiki Washoi** is the reference arena FPS built on the [SHAG Engine](https://github.com/Higher-Standard-Games/shag). Q3/Warsow-style movement, server-authoritative combat, dedicated servers, lobby matchmaking, bots, demos.

This manual covers the game. The engine that runs underneath it has its own manual in the SHAG repo under `docs/manual/`.

---

## What's Here

| Section | For |
|---------|-----|
| [Introduction](./introduction/) | What the game is and what shipped |
| [Getting Started](./getting-started/) | Setup, first run, dedicated server |
| [Player Manual](./player/) | Controls, movement, weapons, pickups, HUD |
| [Gametypes](./gametypes/) | Duel, Amphi, FFA, Search & Destroy |
| [Multiplayer](./multiplayer/) | Lobby, rooms and accounts, connecting, chat, demos |
| [Developer](./developer/) | Architecture, adding weapons + gametypes, server commands |
| [Tools](./tools/) | Bot Intelligence Server, bot training, cinematic demo player |
| [FAQ](./faq/) | Troubleshooting |

---

## Quick Start

```bash
# In the SHAG engine repo (this is a submodule under src/games/fps/)
npm install
npm run dev
# In another terminal: npm run lobby:server
# Open http://localhost:5173 and choose Play, a mode and a room
```

For developer flows (running a local dedicated server, console commands, bot AI), see [Getting Started](./getting-started/).
