# Connecting

How to connect to a game server, manually or through the lobby.

## The menu (the normal way)

1. Open the dev server (`npm --prefix src/games/fps run dev`).
2. The first time a browser reaches the lobby it is asked who you are. The name
   you pick is your account's; leaving it empty keeps the `Player_<number>` the
   lobby gave you. You already have a key at that point — it is what opens the
   same account in another browser, and the Profile key at the foot of the menu
   is where you copy or save it.
3. Pick a mode on the Play stage — Duel, Amphi, FFA or S&D — and take the one
   big action under it to find a room. **Private** beside it makes a room that
   appears in no list; the only way in is the invite link it gives you.
4. In the room you vote for a map, pick a side, add bots, chat with the people
   in it, and mark yourself ready.
5. When everyone is ready, the lobby spawns a dedicated game server for that
   match alone and hands your client its address and a ticket for your seat.
6. The connecting screen takes over and becomes the loading screen where it
   stands: its third step, MAP LOAD, lights up, the stage names the map over its
   levelshot, and a bar fills as the map loads. When the game has set itself
   up, the screen fades and you spawn.
7. When the match ends, **Back to the lobby** brings you back to the same room,
   ready for a rematch.

The loading screen also prepares your held weapons and projectile models.
If required weapon preparation fails, the client reports the failure and
disconnects rather than joining with missing models. Returning from a hidden
tab rechecks rendering readiness; those checks have bounded waits and can be
cancelled when the match connection ends. GPU preparation pauses while the tab
is hidden rather than spending its timeout budget in the background. Player
bodies and combat models are prepared before entering; failed required collision
or model preparation reports an error. Audio prepares alongside the world and
can fall back if the browser cannot finish decoding it promptly.

Rooms you can join are listed down the left rail. The Leaderboard shows your
rank in every mode in its rail, and Profile shows your ranked record beside
your key.

### Joining a match under way

A match that has started still takes players while it has room. Its key in the
rail reads **join**, and pressing it puts you straight into the match, on the
smaller side in a team mode. A full match reads **watch**: you spectate, and
pressing **J** (or **Join** in the match menu) asks for a place. When one has
freed up you are in at once, on the connection you are watching from. When the
match is still full, the chat says so. In a Duel whose two sides are taken —
including a side held for a player who dropped — you are put in the challengers
queue and brought in when it frees. In a round mode you join dead and play from
the next round.

### In the Ready Room

| Action | How it resolves |
|--------|-----------------|
| **Vote map** | Three maps are drawn from the gametype's pool; most votes wins |
| **Switch side** | Immediate, no vote — it affects only you and it is reversible |
| **Vote shuffle** | Randomises the teams; needs a majority (`ceil(players / 2)`) |
| **Add bot** | In any waiting room; a public room becomes private, and its link changes to an invite. Fills a seat using a standard preset near your private rating; new players fall back to medium. The protocol also supports explicit easy, medium, hard and insane presets |
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
disconnect                     # Leave the match and return to the lobby
cl_netgraph 2                  # Show live connection diagnostics
```

The `connect` command lives in `src/games/fps/console/commands/ConnectCommand.ts` (registered at boot by `registerFpsCommands`).

If a `map <name> [gametype]` command was used to dev-spawn a server, the lobby spawn + the network connect happen automatically. You don't need `connect` after `map`.

A server reached with `connect` shows the [join screen](../player/hud.md#join-screen)
once the map is in: join the match, or spectate first.

## What Happens on Connect

1. Browser WebSocket handshake with the game server.
2. The client presents the ticket the lobby gave it. The server admits the seat
   that ticket belongs to — the name a client sends identifies nobody. A seat
   survives a dropped socket, so a reload before the match starts reclaims the
   same one.
3. Server replies with `serverInfo` containing the active map name + gametype + tick rate.
4. Client renders the BSP via the engine's `loadClientMap()` helper (no local simulation — the server is authoritative).
5. Client subscribes to snapshot stream and starts sending input commands.
6. Server adds the player to the simulation; first authoritative snapshot arrives with the spawn position.

## Disconnect Behaviour

`disconnect` does what **Leave match** in the match menu does: it closes the connection and returns you to the lobby. On the way out it tears down:

- The active `NetworkGameHost`
- The input loop
- The snapshot buffer
- The client-side projectile / weapon-view state

If you drop mid-match, your seat is held for 20 seconds and the server hands your client a resume token, so coming back inside that window puts you back in the same seat rather than a new one. Miss it and the seat is released and your name leaves the scoreboard.

## Reading the NetGraph

`cl_netgraph 1` shows ping, snapshot rate, estimated snapshot gaps, interpolation delay, command rate, prediction corrections and extra upload and download delay as text; `cl_netgraph 2` adds a rolling graph of ping and gaps. See [HUD → NetGraph](../player/hud.md#netgraph-bottom-right-optional).

- **Ping** is measured from the server's acknowledgement of your commands, and is the number the scoreboard shows.
- **corr / max** count the times the server corrected your predicted position by more than half a unit, per second, and the largest in the last second. Normally both stay at zero.
- **up / down** show how much longer than your best of the last 30 seconds your commands take to reach the server (`up`) and its updates take to reach you (`down`). A high ping with a high `up` means your upload is queueing behind something else — a file upload, a cloud sync, a weak Wi-Fi uplink. The game keeps you where you are while it waits and catches up afterwards, but nothing can make your shots arrive sooner.
- **Hit registration is lag-compensated.** When you shoot, the server rewinds other players to the tick your client was showing you, so what you saw under your crosshair is what is tested for weapons that use it.

## Ticketed and ticketless connections

A match started through the lobby is ticketed, as above. A `connect` typed at
the console carries no ticket: the server lets it watch, but a playing seat
belongs to a ticket, so it cannot take one. Watching from the lobby's rail is
different: there, Join asks the lobby for a seat.

## Further reading

The engine's Networking Guide (`docs/manual/guides/networking.md` in the engine
repo) covers the underlying mechanics, and its Lobby Server guide
(`docs/manual/guides/lobby-server.md`) covers accounts, rooms and results. This
manual's [Lobby, Rooms and Accounts](./lobby.md) page covers them from the
player's side.
