# Connecting

How to connect to a game server, manually or through the lobby.

## Lobby UI (the normal way)

1. Open the dev server (`npm run dev`).
2. The lobby UI is the first screen. Pick a gametype card.
3. You are placed in a lobby with other players queuing for that gametype.
4. In the ready room you can vote for a map, pick a side, invite bots, and mark
   yourself ready.
5. When enough players are ready, the lobby spawns a dedicated game server and
   tells your client where to connect.
6. The `ConnectingOverlay` shows during the connect; the map loads, and you spawn.

### In the Ready Room

| Action | How it resolves |
|--------|-----------------|
| **Vote map** | Three maps are drawn from the gametype's pool; most votes wins |
| **Switch side** | Immediate, no vote — it affects only you and it is reversible |
| **Vote shuffle** | Randomises the teams; needs a majority (`ceil(players / 2)`) |
| **Invite bot** | Adds a bot at `easy`, `medium` (default), `hard` or `insane` |
| **Ready** | Toggles your ready state |

On a team gametype you are auto-assigned to the smaller side on join. Switching
sides needs no vote because it affects one player and is reversible — and
without it there would be no way to choose a side at all, which makes testing
the attacking half of a round mode impossible.

Bots count as automatic yes votes on a shuffle, but **only once a human has
voted**. A bot has no opinion about team balance, and without this a lobby of
one human plus any number of bots could never reach the majority and so could
never shuffle at all.

The side you end up on is carried through to the game server, so what you chose
in the ready room is what you play.

## Console (the developer way)

```
connect ws://localhost:7777    # Connect to a running dedicated server
disconnect                     # Leave the current server
cl_netgraph 2                  # Show live connection diagnostics
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

For now, the engine's Networking Guide (`docs/manual/guides/networking.md` in the engine repo) covers the underlying mechanics.
