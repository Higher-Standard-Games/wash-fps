# FAQ

Common questions, gotchas, and troubleshooting.

## "Why does `map wdm2` fail with 'No gameplay map launcher registered'?"

The engine command `map` delegates to a launcher that the FPS game registers at boot. Two possibilities:

1. The fps submodule isn't actually loaded / didn't register the launcher → make sure `npm run dev` starts cleanly, no errors in browser console, and `src/main.ts` is calling `registerGameplayMapLauncher(fpsModule.fpsMapLauncher)`.
2. You're running in headless CLI mode (`npm run cli:game`) which intentionally doesn't auto-register the launcher → use `bsp load <name>` instead, or call `registerFpsCommands()` + `registerGameplayMapLauncher()` manually in your script.

## "Why does `map wdm2` say 'Timed out waiting for lobby server to spawn'?"

The lobby server isn't running. Start it:

```bash
npm run lobby:server
```

Then retry `map wdm2`.

## "Why is my dedicated server slow / dropping ticks?"

Usually one of:

- The PK3 data isn't loaded — server can't find the map, falls into a loop trying.
- Too many bots — bots add real CPU load; tune `bot:server` count.
- Tick rate misconfigured (`--tickrate`) — default is 125 Hz; lower if hardware can't keep up.

## "How do I disable the lobby's loopback-only dev-spawn restriction?"

You can't, and you shouldn't. Dev-spawn is a developer affordance, not a public API. Real matches go through normal matchmaking, which has its own authentication + rate limiting. If you want a dedicated public server, run `npm run net:server -- ...` directly with a public host.

## "Bots are too easy / too hard."

Difficulty is tunable via `BotConfig.ts`. For runtime override:

```
bot difficulty <easy|medium|hard|insane>
```

(See [Server Commands](../developer/server-commands.md) — stub for now; commands documented in `src/bot/BotServer.ts`.)

## "My recorded demo won't play back."

Likely causes:

- The demo was recorded on a different protocol version than your current client. The protocol is documented in the engine's [Networking Guide](../../../../../docs/manual/guides/networking.md); demo back-compat is governed by `protocolVersion` in the demo header.
- The map referenced in the demo isn't installed locally — put the PK3 in `public/data/`.

## TODO

- More questions as they come up
- Common shader / texture issues with custom maps
- Capacitor / Electron build gotchas
- Performance tuning checklist
