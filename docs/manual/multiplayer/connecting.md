# Connecting

How to connect to a game server, manually or through the lobby.

## Lobby UI (the normal way)

1. Open the dev server (`npm run dev`).
2. The lobby UI is the first screen. Pick a gametype card.
3. Press **Play** / **Ready**. The lobby queues you with other ready players.
4. When the match is ready, the lobby spawns a dedicated game server and tells your client where to connect.
5. The `ConnectingOverlay` shows during the connect; the map loads, and you spawn.

## Console (the developer way)

```
connect ws://localhost:7777    # Connect to a running dedicated server
disconnect                     # Leave the current server
network status                 # Show current connection state
```

The `connect` command lives in `src/games/fps/console/commands/ConnectCommand.ts` (registered at boot by `registerFpsCommands`).

If a `map <name> [gametype]` command was used to dev-spawn a server, the lobby spawn + the network connect happen automatically. You don't need `connect` after `map`.

## What Happens on Connect

1. Browser WebSocket handshake with the game server.
2. Server replies with `serverInfo` containing the active map name + gametype + tick rate.
3. Client renders the BSP via the engine's `loadClientMap()` helper (no local simulation — the server is authoritative).
4. Client subscribes to snapshot stream and starts sending input commands.
5. Server adds the player to the simulation; first authoritative snapshot arrives with the spawn position.

## Disconnect Behaviour

`disconnect` cleanly closes the WebSocket and tears down:

- The active `NetworkGameHost`
- The input loop
- The snapshot buffer
- The client-side projectile / weapon-view state

If you disconnect mid-match, the server marks you as disconnected after a brief grace window (~3 seconds) — your name leaves the scoreboard cleanly.

## TODO

- Reading NetGraph in detail (ping, snapshot rate, packet loss, interp delay, command rate)
- Recovering from a kicked / disconnected state
- WebTransport vs WebSocket transport selection
- `connect` security considerations (no auth in the dev flow)

For now, the engine's [Networking Guide](../../../../../docs/manual/guides/networking.md) covers the underlying mechanics.
