# Washoi — Arena FPS

Arena FPS game built on the SHAG Engine.

## Features

### Core Gameplay
- **Q3/Warsow Movement** — Strafe-jumping, air control, bunny hopping with momentum preservation
- **Advanced Movement** — Crouchslide (speed-based, 800ms duration), wall-jump (charge + boost), ledge-grab with pull-up
- **Weapon System** — Projectile and hitscan weapons with ADS, recoil, and splash damage
- **Game Modes** — Free-For-All (Deathmatch), Team Deathmatch, Duel (1v1)
- **BSP Collision** — Full Quake 3 / Warsow FBSP map support with swept AABB physics

### Multiplayer
- **Server-Authoritative Networking** — 125Hz tick rate, client-side prediction, server reconciliation
- **Dedicated Server** — Headless CLI server with WebSocket and WebTransport
- **Lobby System** — Match orchestration, queue management, team balancing
- **Snapshot Interpolation** — Smooth remote player rendering with delta-compressed state sync
- **Lag Compensation** — Server-side hit detection rewinding

### Bot System (Bot Intelligence Server)
- **Separate Process Architecture** — Bots run in a dedicated Node.js process, connect to game servers as real clients via WebSocket. Indistinguishable from human players at the protocol level
- **State Machine AI** — Priority-based behavior: fight → hunt → retreat → chase → dodge → item_run
- **BSP Vision** — Line-of-sight, spatial awareness, and cover evaluation via BSP raytracing (no precomputed navmesh)
- **NavGraph Pathfinding** — A* search on BSP-derived Smart Waypoint Network (items, spawns, floor-sampled nodes)
- **Difficulty Presets** — Easy / Medium / Hard / Insane with configurable aim accuracy, reaction time, tracking speed, and mistake rate
- **TensorFlow.js Enhancement** — HybridBrain with dual neural networks (tactical + combat models) layered on top of rule-based AI
- **Autonomous Training** — Self-play training pipeline: bots play each other, record episodes, compute rewards, update neural weights
- **Lobby Integration** — Bots join through the lobby server, queue for matches, and auto-ready like human players

### Recording & Playback
- **Demo Recording** — Server-side match recording in `.shagdemo` binary format (all player inputs + entity state per tick)
- **Demo Listing** — Lobby server scans and serves available demo files

### Player Rendering
- **Third-Person Animations** — Skeletal animations for remote players: walk, run, crouch walk/idle, crouchslide, wall-jump, blade attack
- **Weapon Bone Attachment** — Equipped weapons render on remote players via `attachToBone()` with per-weapon orientation correction
- **HUD** — Health, armor, ammo display with scalable UI components

### In Progress 🚧
- CTF game mode
- Scoreboard and match timer UI
- Full NavGraph integration into brain pathfinding (jump pads, teleporters)
- Neural network training from recorded match demos

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

```
# In game console (~):
connect localhost:7777
```

### Bot Server

```bash
npm run bot:server
# Interactive console — bots connect to game server and play autonomously
```

## Directory Structure

```
wash-fps/
├── FPSPlayer.ts                  # Client player controller
├── Game.ts                       # Network game manager
├── client/
│   ├── V2NetworkClient.ts        # Client prediction & reconciliation
│   └── InputHistory.ts           # Input replay buffer
├── server/
│   ├── GameServer.ts             # Authoritative game server
│   ├── DemoRecorder.ts           # Match recording
│   ├── SnapshotBroadcaster.ts    # Delta-compressed state broadcast
│   ├── SnapshotBuilder.ts        # Server snapshot assembly
│   ├── MovementValidator.ts      # Anti-cheat movement validation
│   ├── gametypes/                # DM, TDM, Duel controllers
│   ├── systems/                  # Server game systems
│   └── weapons/                  # Weapon definitions
└── simulation/
    ├── MovementProfile.ts        # Shared movement physics
    ├── FPSSimulation.ts          # Client/server simulation
    ├── Acceleration.ts           # Air/ground acceleration
    ├── Slide.ts                  # Crouchslide mechanics
    ├── WallJump.ts               # Wall-jump mechanics
    ├── LedgeGrab.ts              # Ledge-grab mechanics
    └── collision/                # Collision detection
```

Bot system lives separately in `src/bot/`:

```
src/bot/
├── BotServer.ts              # Bot Intelligence Server
├── BotClient.ts              # Headless network client per bot
├── BotBrain.ts               # AI base class
├── BotGameState.ts           # World state parsed from snapshots
├── BotVision.ts              # BSP raytracing (LOS, cover, spatial awareness)
├── BotNavGraph.ts            # A* waypoint pathfinding
├── BotConfig.ts              # Difficulty presets and bot names
├── BotMovementProfile.ts     # Movement mechanics knowledge
├── BotWeaponProfile.ts       # Weapon stats knowledge
├── BotInputNormalizer.ts     # State → neural network input normalization
├── BotEpisodeRecorder.ts     # Training data collection
├── BotRewardComputer.ts      # Reward calculation for training
├── BotTrainer.ts             # Autonomous training loop
└── BotLobbyClient.ts         # Lobby server integration
```

## Game Data

Game assets (maps, textures, pk3 files) are **not included** in this repository.
Place your game data in `public/data/` within the engine repo.

## License

MIT
