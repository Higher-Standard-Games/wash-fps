# Project Structure

What lives where inside this submodule. Paths are relative to the submodule root (`src/games/fps/` from the engine repo's perspective).

```
src/games/fps/
├── Game.ts                    # Network game manager — owns the active IGameHost
├── FPSPlayer.ts               # High-level player entity (inventory + controller wiring)
├── ClientEntityKey.ts         # Stable keys for client-side entities
├── index.ts                   # Public exports (Game, registerFpsCommands, ...)
├── game.json                  # Game manifest (name, version, entry point)
│
├── client/                    # Anything that runs only on the client
│   ├── LobbyPanel.ts          # The lobby (play stage, rooms, rail menu)
│   ├── ProfileView.ts         # Account, key and ranked record
│   ├── LeaderboardView.ts     # Rankings per mode
│   ├── DemosView.ts           # Demos page (featured / latest / yours)
│   ├── WelcomeOverlay.ts      # First-run name / key screen
│   ├── RoomChatView.ts        # Chat in a lobby room
│   ├── FpsLobbyService.ts     # Shared lobby connection
│   ├── FpsMapLauncher.ts      # `map <name> [gametype]` → lobby dev-spawn
│   ├── FpsNetworkConnector.ts # Engine NetworkConnector adapter
│   ├── V2NetworkClient.ts     # Prediction, reconciliation, snapshots
│   ├── GameEvents.ts          # Server → client event handlers
│   ├── DemoService.ts         # Demo loading + analysis
│   ├── DemoViewer.ts          # Frame-by-frame playback engine
│   ├── Spectator*.ts, Spectate*.ts  # Free-fly and follow-a-player spectating
│   ├── RemotePlayerRenderer.ts, RagdollSystem.ts, GibSystem.ts, ...
│   ├── FPS*Audio.ts           # Combat, movement, pickup, powerup and liquid sound
│   ├── hud/                   # HUD widgets (weapon rack, vitals, scoreboard, match menu, ...)
│   ├── settings/              # Settings screen (controls, gameplay, video, audio)
│   └── styles/                # CSS for the lobby, menus, demos, leaderboard
│
├── console/                   # Game-specific console commands
│   ├── index.ts               # registerFpsCommands() auto-discovery
│   └── commands/              # Connect, Disconnect, Demo*, Loadout, Water, NetTest, audits
│
├── server/                    # Authoritative server code
│   ├── GameServer.ts          # The orchestrator
│   ├── SnapshotBuilder.ts, SnapshotBroadcaster.ts
│   ├── DemoRecorder.ts
│   ├── MovementValidator.ts, AuthorityGuards.ts
│   ├── SuspendedSessions.ts   # Seats held through a dropped connection
│   ├── gametypes/
│   │   ├── GametypeController.ts, MatchState.ts, BaseGametype.ts
│   │   ├── Duel.ts, Amphi.ts, Deathmatch.ts, TeamDeathmatch.ts, SearchAndDestroy.ts
│   │   └── AwardTracker.ts, SpawnPointStrategy.ts
│   └── systems/
│       ├── PickupSystem.ts, WeaponSystem.ts, ProjectileSystem.ts
│       ├── CombatSystem.ts, DroppedWeaponSystem.ts
│       └── FPSMovementSubsystem.ts, LiquidWorldEffects.ts, ...
│
├── simulation/                # Physics + movement (shared between client + server)
│   ├── FPSSimulation.ts       # The Simulation implementation
│   ├── MovementProfile.ts     # Movement orchestrator + default config
│   ├── Acceleration.ts        # Air / ground acceleration math
│   ├── Slide.ts, WallJump.ts, LedgeGrab.ts
│   ├── Ladder.ts, Swim.ts     # Climbing and swimming
│   └── collision/             # FPS-specific BSP collision world wrapper
│
├── liquid/                    # Water, slime and lava state (shared by sim, server, client)
├── models/                    # Trained bot model weights
├── world/                     # In-world entities (FPS subclasses of engine types)
│   ├── FPSPickup.ts           # Extends engine Pickup with type taxonomy + registry
│   ├── InventoryManager.ts    # Q3-style 3-slot inventory + ammo
│   ├── PickupPrompt.ts        # "PRESS [F] TO SWAP" HUD prompt
│   └── pickups/procedural/    # Procedural pickup visuals
├── docs/manual/               # This manual (VitePress)
└── __tests__/                 # Tests live in __tests__ folders beside the code
```

Weapon and projectile definitions are **not** in this repo: they live in the engine at `src/shared/entities/definitions/`. See [Adding a Weapon](../developer/adding-a-weapon.md).

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
