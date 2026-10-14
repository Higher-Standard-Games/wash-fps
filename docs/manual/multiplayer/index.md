# Multiplayer

How matches happen.

| Page | Covers |
|------|--------|
| [Lobby, Rooms and Accounts](./lobby.md) | The lobby screen, accounts and keys, rooms, ranked matches, leaderboard, profile |
| [Connecting](./connecting.md) | `connect` / `disconnect` console, lobby UI flow, joining a match under way, reconnecting, NetGraph |
| [In-Game Chat](./chat.md) | **T** to talk, history dialog, chat in demos |
| [Demos](./demos.md) | Server-side recording, demo list, playback (normal + cinematic) |

## High-Level Flow

```mermaid
sequenceDiagram
  accTitle: Lobby to live match
  accDescr: Players ready in the lobby, receive a seat ticket, and exchange gameplay commands and snapshots with a dedicated match server.
  participant UI as Lobby UI (browser)
  participant Lobby as Lobby server
  participant Game as Dedicated game server
  UI->>Lobby: Join a room, vote and ready up
  Lobby->>Game: Spawn a match server
  Lobby-->>UI: Server address and seat ticket
  UI->>Game: WebSocket connection and admission
  loop Live match
    UI->>Game: Input commands
    Game-->>UI: Authoritative snapshots and events
  end
```

The lobby orchestrates matchmaking and spawns dedicated game servers via `GameServerSpawner`. Players never connect directly to the lobby for gameplay — they connect to the game server the lobby tells them about.

For developer flows, the engine's `map <name> [gametype]` command bypasses the matchmaker and asks the lobby for a one-off dev-spawn. See the engine's Map Launching Guide (`docs/manual/guides/map-launching.md` in the engine repo).
