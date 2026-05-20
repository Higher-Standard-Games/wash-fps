# Project Structure

What lives where inside this submodule. Paths are relative to the submodule root (`src/games/fps/` from the engine repo's perspective).

```
src/games/fps/
├── Game.ts                    # Network game manager — owns the active IGameHost
├── FPSPlayer.ts               # High-level player entity (inventory + controller wiring)
├── index.ts                   # Public exports (Game, registerFpsCommands, ...)
├── game.json                  # Game manifest (name, version, entry point)
│
├── client/                    # Anything that runs only on the client
│   ├── DemoService.ts         # Demo loading + analysis
│   ├── DemoViewer.ts          # Frame-by-frame playback engine
│   ├── DroppedWeaponRenderer.ts
│   ├── FpsMapLauncher.ts      # `map <name> [gametype]` → lobby dev-spawn
│   ├── FpsNetworkConnector.ts # Engine NetworkConnector adapter
│   ├── FpsLobbyService.ts     # Shared lobby connection
│   ├── LobbyPanel.ts          # Lobby UI (matchmaking, demos, settings)
│   ├── GameEvents.ts          # Server → client event handlers
│   ├── hud/                   # HUD widgets (weapon slots, ammo, health, kill feed)
│   └── settings/              # Settings UI (controls, audio, video)
│
├── console/                   # Game-specific console commands
│   ├── index.ts               # registerFpsCommands() auto-discovery
│   └── commands/
│       ├── ConnectCommand.ts
│       ├── DisconnectCommand.ts
│       ├── DemoCommand.ts
│       ├── DemoListCommand.ts
│       ├── DemoPlayCommand.ts
│       └── NetTestCommand.ts
│
├── server/                    # Authoritative server code
│   ├── GameServer.ts          # The orchestrator
│   ├── SnapshotBuilder.ts
│   ├── SnapshotBroadcaster.ts
│   ├── DemoRecorder.ts
│   ├── MovementValidator.ts
│   ├── gametypes/
│   │   ├── GametypeController.ts
│   │   ├── MatchState.ts
│   │   ├── Duel.ts
│   │   ├── Deathmatch.ts
│   │   └── TeamDeathmatch.ts
│   ├── systems/
│   │   ├── PickupSystem.ts
│   │   ├── WeaponSystem.ts
│   │   ├── CombatSystem.ts
│   │   ├── DroppedWeaponSystem.ts
│   │   └── ...
│   └── weapons/
│       ├── WeaponDef.ts
│       └── index.ts
│
├── simulation/                # Physics + movement (shared between client + server)
│   ├── FPSSimulation.ts       # The Simulation implementation
│   ├── MovementProfile.ts     # Movement config (defaults + cvars)
│   ├── Acceleration.ts        # Air / ground acceleration math
│   ├── Slide.ts               # Crouchslide
│   ├── WallJump.ts            # Wall-jump charge + boost
│   ├── LedgeGrab.ts           # Ledge detection + pull-up
│   └── collision/             # FPS-specific BSP collision world wrapper
│
└── world/                     # In-world entities (FPS subclasses of engine types)
    ├── FPSPickup.ts           # Extends engine Pickup with type taxonomy + registry
    ├── InventoryManager.ts    # Q3-style 3-slot inventory + ammo
    └── PickupPrompt.ts        # "PRESS [F] TO PICKUP" HUD prompt
```

## Where things plug into the engine

| Submodule file | Engine extension point |
|----------------|------------------------|
| `client/FpsNetworkConnector.ts` | `NetworkConnector` registry (`src/engine/ui/components/NetworkConnector.ts`) |
| `client/FpsMapLauncher.ts` | `GameplayMapLauncher` registry (`src/engine/console/GameplayMapLauncher.ts`) |
| `console/commands/*` | `CommandRegistry` via `registerFpsCommands()` |
| `world/FPSPickup.ts` | Subclasses engine `Pickup` (`src/engine/world/Pickup.ts`) |
| `simulation/FPSSimulation.ts` | Implements engine `Simulation<State, Input>` |
| `server/GameServer.ts` | Wraps engine networking transports + tick loop |

## Bot Intelligence Server lives outside this submodule

The bot system runs as a separate Node.js process and lives at `src/bot/` in the engine repo (not in this submodule). See [Tools → Bot Server](../tools/bot-server.md).
