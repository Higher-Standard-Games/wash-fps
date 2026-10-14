# Project Structure

What lives where inside this submodule. Paths are relative to the submodule root (`src/games/fps/` from the engine repo's perspective).

Paths below are relative to `src/games/fps/`.

| Area | Files and responsibility |
| --- | --- |
| Root | `Game.ts` owns the active game host; `FPSPlayer.ts` wires the player; `ClientEntityKey.ts` defines stable client keys; `index.ts` exports the game API; `game.json` describes the module |
| `client/` — lobby | `LobbyPanel.ts`, `ProfileView.ts`, `LeaderboardView.ts`, `DemosView.ts`, `WelcomeOverlay.ts`, `RoomChatView.ts` |
| `client/` — engine adapters | `FpsLobbyService.ts`, `FpsMapLauncher.ts`, `FpsNetworkConnector.ts` |
| `client/` — gameplay | `V2NetworkClient.ts` handles prediction/snapshots; `GameEvents.ts` handles events; remote-player, ragdoll, gib and audio systems present the world |
| `client/` — watching | `DemoService.ts`, `DemoViewer.ts`, `Spectator*.ts`, `Spectate*.ts` |
| `client/hud/`, `client/settings/`, `client/styles/` | HUD widgets, settings pages and game UI styles |
| `console/` | `index.ts` discovers game commands in `commands/` |
| `server/` | `GameServer.ts`, `SnapshotBuilder.ts`, `SnapshotBroadcaster.ts`, `DemoRecorder.ts`, `MovementValidator.ts`, `AuthorityGuards.ts`, `SuspendedSessions.ts` |
| `server/gametypes/` | `GametypeController.ts`, `MatchState.ts`, `BaseGametype.ts`; Duel, Amphi, Deathmatch and Search & Destroy; awards and spawn strategies |
| `server/systems/` | Pickup, weapon, projectile, combat, dropped-weapon, movement and liquid subsystems |
| `simulation/` | `FPSSimulation.ts`, `MovementProfile.ts`, `Acceleration.ts`, slide/wall-jump/ledge-grab/ladder/swim mechanics and `collision/` — shared by client and server |
| `liquid/` | Water, slime and lava state shared by simulation, server and client |
| `models/` | Trained bot model weights |
| `world/` | `FPSPickup.ts`, `InventoryManager.ts`, `PickupPrompt.ts`, `pickups/procedural/` |
| `docs/manual/` | This VitePress manual |
| `__tests__/` folders | Tests alongside the systems they cover |

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
