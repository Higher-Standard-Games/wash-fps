# Multiplayer

How matches happen.

| Page | Covers |
|------|--------|
| [Connecting](./connecting.md) | `connect` / `disconnect` console, lobby UI flow, NetGraph |
| [In-Game Chat](./chat.md) | **T** to talk, history dialog, chat in demos |
| [Demos](./demos.md) | Server-side recording, demo list, playback (normal + cinematic) |

## High-Level Flow

```
┌──────────────┐                  ┌──────────────┐                ┌──────────────┐
│ Lobby UI     │ ─── queue ──▶    │ Lobby Server │ ─── spawn ──▶  │ Game Server  │
│ (browser)    │                  │ (Node)       │                │ (dedicated)  │
└──────┬───────┘                  └──────────────┘                └──────┬───────┘
       │                                                                 │
       │  ◀───────────────── ws connect on player ready ─────────────────┘
       │                       125 Hz tick / 60 Hz snapshots
       ▼
   gameplay
```

The lobby orchestrates matchmaking and spawns dedicated game servers via `GameServerSpawner`. Players never connect directly to the lobby for gameplay — they connect to the game server the lobby tells them about.

For developer flows, the engine's `map <name> [gametype]` command bypasses the matchmaker and asks the lobby for a one-off dev-spawn. See the engine's Map Launching Guide (`docs/manual/guides/map-launching.md` in the engine repo).
