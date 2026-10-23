# FAQ

Common questions, gotchas, and troubleshooting.

## "Why does `map washoi_dm2` fail with 'No gameplay map launcher registered'?"

The engine command `map` delegates to a launcher that the FPS game registers at boot. Two possibilities:

1. The fps submodule isn't actually loaded / didn't register the launcher → make sure `npm run dev` starts cleanly, no errors in browser console, and `src/main.ts` is calling `registerGameplayMapLauncher(fpsModule.fpsMapLauncher)`.
2. You're running in headless CLI mode (`npm run cli:game`) which intentionally doesn't auto-register the launcher → use `bsp load <name>` instead, or call `registerFpsCommands()` + `registerGameplayMapLauncher()` manually in your script.

## "Why does `map washoi_dm2` say 'Timed out waiting for lobby server to spawn'?"

The lobby server isn't running. Start it:

```bash
npm run lobby:server
```

Then retry `map washoi_dm2`.

## "Why is my dedicated server slow / dropping ticks?"

Usually one of:

- The PK3 data isn't loaded — server can't find the map, falls into a loop trying.
- Too many bots — bots add real CPU load; tune `bot:server` count.
- Tick rate misconfigured (`--tickrate`) — default is 125 Hz; lower if hardware can't keep up.

## "How do I disable the lobby's loopback-only dev-spawn restriction?"

You can't, and you shouldn't. Dev-spawn is a developer affordance, not a public API. Real matches go through normal matchmaking, which has its own authentication + rate limiting. If you want a dedicated public server, run `npm run net:server -- ...` directly with a public host.

## "Bots are too easy / too hard."

Bots are available in **Private** rooms. The room chooses a standard preset near
your private rating, with medium as the new-player fallback. Explicit protocol
presets are easy, medium, hard and insane. Presets live in `BotConfig.ts` in the
game's `bot/` directory; [Bot Server](../tools/bot-server.md#difficulty-tiers) lists the tiers.
The dedicated server's `spawn_bots` command makes simple bots with no tiers; see
[Server Commands](../developer/server-commands.md).

## "Why can't I join the match I clicked?"

A match under way takes players only while it has room. Otherwise you watch, and **J** asks for a seat if one frees up. Duel keeps a challengers queue. In a round mode you join dead and play from the next round. See [Connecting](../multiplayer/connecting.md#joining-a-match-under-way).

## "I lost my account / I'm on a new computer."

Use your account **key**: choose **Use my key** on the welcome screen, or **Profile** in the lobby, and enter it. The lobby only sees your key when you log in, so it can't recover a lost one. Save it from Profile (**Copy key** or **Save as file**) while you still have it. See [Lobby, Rooms and Accounts](../multiplayer/lobby.md#accounts).

## "I dropped mid-match. Can I get back in?"

Yes, within 20 seconds. Your seat is held and your client is given a resume token, so reconnecting puts you back in the same seat. After that the seat is released.

## "Why didn't my match show on the leaderboard?"

Check the **mode** and **Public / Private** pool first. Records and rating updates
are separate: an unrated match may still appear in Profile history. Standard bot
matches can rate in the private pool. Late joins, changed sides, interrupted
participation and invalid results can prevent an update; history explains the
decision. See [Ranked matches](../multiplayer/lobby.md#ranked-matches).

## "My recorded demo won't play back."

Likely causes:

- The demo was recorded on a different protocol version than your current client. The protocol is documented in the engine's Networking Guide (`docs/manual/guides/networking.md` in the engine repo); demo back-compat is governed by `protocolVersion` in the demo header.
- The map referenced in the demo isn't installed locally — put the PK3 in `public/data/`.

## "Where is the map editor documented?"

The map editor (SHAGGED) belongs to the engine, so its documentation is in the engine repo, not in this manual. When you start a match from the editor as a playtest, the match menu's **Leave match** key reads **Return to Editor** and takes you back to your map.
