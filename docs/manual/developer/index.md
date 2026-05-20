# Developer

Building on Washiki Washoi. Architecture overview + how-tos for the common extension points.

## Architecture at a Glance

```
┌────────────────────────────────────────────────────────────┐
│                     SHAG Engine                            │
│        (BSP / PK3 / shaders / physics / networking)        │
└─────────────────────────┬──────────────────────────────────┘
                          │ extends + plugs into
                          ▼
┌────────────────────────────────────────────────────────────┐
│                      Washiki Washoi                        │
│                  (src/games/fps/, this submodule)          │
│                                                            │
│  client/      console/      world/      simulation/        │
│  server/      gametypes      systems/   weapons/           │
└────────────────────────────────────────────────────────────┘
```

Three things to understand before extending:

1. **The server is authoritative.** All gameplay state lives on the server. The client predicts locally for responsiveness, but the server's tick is the source of truth.
2. **The simulation is shared.** `simulation/FPSSimulation.ts` runs on client (predicted) and server (authoritative). Identical code, identical config. Drift between them is a bug.
3. **The engine seam.** The submodule talks to the engine through documented extension points: `NetworkConnector`, `GameplayMapLauncher`, `Pickup` (subclass), `CommandRegistry`, `IGameHost`. See [`getting-started/project-structure.md`](../getting-started/project-structure.md) for the full mapping.

## How-Tos

| Page | Covers |
|------|--------|
| [Adding a Weapon](./adding-a-weapon.md) | Defining a new `WeaponDef`, projectile, HUD slot |
| [Adding a Gametype](./adding-a-gametype.md) | Subclassing `BaseGametype`, score/time rules, registration |
| [Server Commands](./server-commands.md) | Op commands for dedicated server admins |

## Code Conventions

- **Singleton pattern** throughout. `XYZ.getInstance()`. Reset hygiene matters — use `resetInstance()` in tests.
- **EventBus** for decoupled events. Always store unsubscribe handles.
- **No `Game.initializeLocal`.** Everything goes through `NetworkGameHost` now (since v0.9.15 in the engine). Single-player runs a real dedicated server in-process via the lobby's dev-spawn — see the engine's [Map Launching Guide](../../../../../docs/manual/guides/map-launching.md).
- **Submodule edits commit to this repo first**, then the outer engine repo bumps the submodule pin. AGENTS.md in the engine repo documents the flow.

## Tests

Tests live in `__tests__/` directories next to the code they cover. Run from the outer engine repo:

```bash
npm test           # all tests, including submodule
npm test FPSPickup # filter by name pattern
```

The outer `vitest` config picks up `src/games/fps/**/*.test.ts` automatically.

## See Also

- The engine's [Service Registries](../../../../../docs/manual/guides/service-registries.md) guide — how to add new engine→game injection points
- The engine's [Pickup System](../../../../../docs/manual/guides/pickup-system.md) guide — Pickup base class hooks
