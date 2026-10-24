# Troubleshooting Setup

Problems people hit getting the game running, with what to check. For gameplay questions see the [FAQ](../faq/index.md).

## The game folder is empty

This game is a git submodule of the engine, and a plain `git clone` leaves submodules empty. Clone with `--recursive`, or fetch them afterwards:

```bash
git submodule update --init
```

## npm reports "Missing script: lobby:server"

Game commands belong to the package in `src/games/fps`. From the SHAG root:

```powershell
npm --prefix src/games/fps run lobby:server
npm --prefix src/games/fps run bot:server
```

Run these in separate terminals. Alternatively, enter `src/games/fps` and use
`npm run lobby:server` or `npm run bot:server`. Both forms use the SHAG root for
data and build output. Install dependencies at the SHAG root, once.
See [Starting servers](../developer/server-commands.md#starting-servers).

## The lobby says "Offline"

The rail's player card reads **Offline**, the room list reads **Lobby server offline.**, and chat says **Lobby offline**. The browser is running but the lobby server isn't.

```bash
npm --prefix src/games/fps run lobby:server            # listens on port 9000
npm --prefix src/games/fps run lobby:server -- --port 9001
```

The browser looks for `ws://localhost:9000`. If you started the lobby on another port or host, set `VITE_LOBBY_URL` (for example `VITE_LOBBY_URL=ws://localhost:9001`) before `npm --prefix src/games/fps run dev`.

The console's `map <name> <gametype>` also needs the lobby running, because it asks the lobby to start a one-off server. If it reports `Timed out waiting for lobby server to spawn`, this is why.

## A mode is missing from the Play stage, or won't start

A mode the lobby doesn't run is reported as *"`<MODE>` is not offered by this lobby server yet"* and can't be started. The first release offers Duel, Amphi, FFA and S&D.

A mode with no maps is missing or fails to start. The lobby offers a map only when it is listed in `config/maps.json` **and** `map_<name>.pk3` exists in `public/data/`, and it reads that list once, **when it starts**. So after adding game data or editing the config, restart the lobby server. **Amphi** is the strictest: it is hidden completely unless its own map PK3s are installed. See [Maps](../gametypes/maps.md).

## Maps, textures or models don't load

Game data is not in either repository. PK3 files (maps, textures, models, sounds) go in `public/data/` in the engine repo, which is gitignored, so every developer sets up their own copy. After adding or changing PK3s, rebuild the manifests:

```bash
npm run tools:manifest
npm run tools:textures
```

To check a map outside the game, from the engine repo:

```bash
npm --prefix src/games/fps run cli:game -- --exec "bsp load washoi_dm2; bsp info; quit"
```

## "Rankings are unavailable" and "Featured demos are unavailable"

These messages mean the lobby server you are connected to doesn't provide that feature, or you aren't connected. Start the lobby with `npm --prefix src/games/fps run lobby:server` from the engine repo to get the leaderboard and featured demos.

## Bots don't join

The bot server and the lobby share a secret, and the bot server's control port (9100) only listens on `127.0.0.1`.

- Start the lobby and the bot server **from the same folder**, or give both the same `--data-dir`, or set `BOT_SECRET` for both.
- Run them on the same machine.
- Remember the bot server is its own process: `npm --prefix src/games/fps run bot:server`.

See [Bot Server](../tools/bot-server.md#the-lobby-and-the-shared-secret).

## Connecting to a dedicated server

```
connect ws://localhost:7777
```

- The port must match `--port`; the default is **7777**.
- A server started by hand has no ticket system for you, so a console `connect` lets you **watch** and join from the [join screen](../player/hud.md#join-screen), but a playing seat in a lobby match belongs to a ticket.
- The server's own terminal shows the map and gametype it loaded. Unknown `--gametype` values fall back to **Deathmatch** without an error, so a typo shows up as the wrong mode, not a failure. See [Server Commands](../developer/server-commands.md#server-launch-options).

## TLS certificates (WebTransport)

The dedicated server can use WebTransport, which needs a TLS certificate. For development, install [mkcert](https://github.com/FiloSottile/mkcert), then:

```bash
mkcert -install
mkcert localhost
```

Move `localhost.pem` and `localhost-key.pem` into `./certs/`. The paths can be changed with `--cert` and `--key`, or `SHAG_GAME_CERT_PATH` and `SHAG_GAME_KEY_PATH`.

## Wrong Node version

The repository pins Node **22** (`.nvmrc`). Node 18 is the minimum; use 22 if you can.

## Lost an account, or a match didn't rank

See the FAQ entries on [account keys](../faq/index.md) and [ranked matches](../faq/index.md).
