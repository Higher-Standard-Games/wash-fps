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
| `cli/` | Dedicated-server, lobby and bot startup; game console runner; simulation/server checks; demo recording/verification, collision and timedemo fixtures; sound audit; SHAGGED application entry points; bot tools and map-loading composition |
| `bot/` | Bot clients, navigation, brains, training and their tests |
| `scripts/` | Server build recipe with explicit artifact names and atomic output publication; optional water/experiment fixtures and historical probes under `diagnostics/` |
| `server/` | `GameServer.ts`, `SnapshotBuilder.ts`, `SnapshotBroadcaster.ts`, `DemoRecorder.ts`, `MovementValidator.ts`, `AuthorityGuards.ts`, `SuspendedSessions.ts` |
| `server/gametypes/` | `GametypeController.ts`, `MatchState.ts`, `BaseGametype.ts`; Duel, Amphi, Deathmatch and Search & Destroy; awards and spawn strategies |
| `server/systems/` | Pickup, weapon, projectile, combat, dropped-weapon, movement and liquid subsystems |
| `simulation/` | `FPSSimulation.ts`, `MovementProfile.ts`, `Acceleration.ts`, slide/wall-jump/ledge-grab/ladder/swim mechanics and `collision/` — shared by client and server |
| `liquid/` | Water, slime and lava state shared by simulation, server and client |
| `models/` | Trained bot model weights |
| `world/` | `FPSPickup.ts`, `InventoryManager.ts`, `PickupPrompt.ts`, `pickups/procedural/` |
| `docs/manual/` | This VitePress manual |
| `__tests__/` folders | Tests alongside the systems they cover |

Weapon, projectile, ammo and item definitions live in this repo at
`shared/entities/definitions/`, alongside `shared/entities/initEntityDefs.ts`.
Both the client and server use these same definitions. Generic interfaces and
the registry remain in the engine. See [Adding a Weapon](../developer/adding-a-weapon.md).

## Server assembly commands

With this game checked out at `src/games/fps/` inside the SHAG checkout and
dependencies installed at the assembled root, run these from that root:

```bash
node src/games/fps/scripts/build-servers.mjs
node dist-server/lobby-server.mjs --port 9000 --data-dir ./server-data
```

The build recipe belongs to this repository; its default output remains the
assembled root's `dist-server/`. An optional first argument selects another
output directory, absolute or relative to the assembled root. The root's
`npm --prefix src/games/fps run build:server` and `npm --prefix src/games/fps run lobby:server:dev` commands delegate to the
game-owned recipe and source entry. The lobby, bot server and match server
artifact filenames stay the same. Use a scratch `--data-dir` for automated tests.

The recipe also builds this game's `cli/bot-server.ts` and the runtime/benchmark
probes whose source entry points still live in SHAG. Reusable lobby, account, result and
networking services remain engine-owned; the game supplies their application
startup and the dedicated-server entry descriptor.

The lobby CLI supplies `isBotName` to SHAG's `PlayerStore.open` and
`resolveFPSDemoMap` through `LobbyServerOptions.resolveDemoMap`. The browser's
`FpsLobbyService` passes the same bot-name predicate into account login, and
`IdentityFields` uses it for name validation. Keep these inputs aligned when
changing reservations. Demo aliases affect levelshot media lookup while the
recorded map identity remains unchanged.

## Where things plug into the engine

Tests that exercise Washoi through SHAG services live with the game:
`client/__tests__/` covers demo playback, local water-reflection presentation
and FPS input bindings; `simulation/__tests__/SharedCollisionGrounding.test.ts`
covers collision support with the game's movement profile;
`server/__tests__/lobby/` covers demo ownership and real lobby/match/result
integration. Run `npm --prefix src/games/fps run test:run` from the assembled root to discover them;
`npm --prefix src/games/fps run ranking:acceptance` includes the lobby integration group.

| Submodule file | Engine extension point |
|----------------|------------------------|
| `client/FpsNetworkConnector.ts` | `NetworkConnector` registry (`src/engine/ui/components/NetworkConnector.ts`) |
| `client/FpsMapLauncher.ts` | `GameplayMapLauncher` registry (`src/engine/console/GameplayMapLauncher.ts`) |
| `console/commands/*` | `CommandRegistry` via `registerFpsCommands()` |
| `world/FPSPickup.ts` | Subclasses engine `Pickup` (`src/engine/world/Pickup.ts`) |
| `simulation/FPSSimulation.ts` | Implements engine `Simulation<State, Input>` |
| `server/GameServer.ts` | Wraps engine networking transports + tick loop |

## Bot Intelligence Server

The bot system runs as a separate Node.js process and lives in this repository's
`bot/` directory, with startup in `cli/bot-server.ts`. See
[Tools → Bot Server](../tools/bot-server.md).
