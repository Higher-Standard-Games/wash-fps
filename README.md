# W.A.S.H FPS

**W**arsow **A**nd **SH**AG - Arena FPS game built on the SHAG Engine.

## Features

### Implemented ✅

- **Q3-Style Movement** - Strafe jumping, air control, crouch sliding
- **Server-Authoritative Networking** - 125Hz tick rate, client prediction, reconciliation
- **BSP Collision** - Full support for Quake 3 / Warsow FBSP maps
- **Weapon System** - Projectile and hitscan weapons
- **Dedicated Server** - Headless CLI server with WebSocket/WebTransport

### In Progress 🚧

- HUD system (health, armor, ammo)
- Scoreboard and match timer
- Weapon switching UI
- Game modes (DM, TDM, CTF)

## Setup

This game requires the [SHAG Engine](https://github.com/Higher-Standard-Games/shag).

### Clone with Engine

```bash
git clone --recursive https://github.com/Higher-Standard-Games/shag.git
cd shag
npm install
npm run dev
```

### Add to Existing Engine Clone

```bash
git submodule add git@github.com:Higher-Standard-Games/wash-fps.git src/games/fps
git submodule update --init
```

### Update to Latest

```bash
cd src/games/fps
git pull origin main
cd ../..
git add src/games/fps
git commit -m "chore: update fps submodule"
```

## Running

### Development Server

```bash
npm run dev
# Open http://localhost:3000
# Press ~ for console, type: map wdm1
```

### Dedicated Server

```bash
npm run net:server -- --map wdm2 --port 7777
```

### Connect to Server

```bash
# In game console (~):
connect localhost:7777
```

## Directory Structure

```
wash-fps/
├── FPSPlayer.ts              # Client player controller
├── Game.ts         # Network game manager
├── client/
│   ├── V2NetworkClient.ts    # Q3-style prediction & reconciliation
│   └── InputHistory.ts       # Input replay buffer
├── server/
│   ├── systems/              # Server game systems
│   └── weapons/              # Weapon definitions
└── simulation/
    ├── FPSMovementProfile.ts # Shared movement physics
    └── FPSSimulation.ts      # Client/server simulation
```

## Game Data

Game assets (maps, textures, pk3 files) are **not included** in this repository.
Place your game data in `public/data/` within the engine repo.

## License

MIT
