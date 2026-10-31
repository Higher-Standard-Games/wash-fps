# A native Washoi client in Rust

Opened: October 31, 2026. Status: research, round 1. No port code yet.

**End goal:** a native Washoi game client, written in Rust, that connects to the
servers that run today (`wss://eu.washoi.net`, `wss://us.washoi.net`), plays a
full match against browser players, and keeps the shape of the SHAG/Washoi code
so that anyone who knows the TypeScript can find their way around the Rust.

This document is an investigation journal. Each round goes one layer deeper and
appends to it. Round 1 maps the whole client, writes down the network contract
exactly as the code implements it, and proposes the crate map, workspace layout
and milestone plan. Later rounds take one layer each down to function level.

Why it lives here: the end product is the Washoi client, so it sits in
`wash-fps/docs/research`. Most of the code it translates is SHAG
(`src/engine`, `src/shared`), and SHAG's research docs are linked where they
matter.

Every claim below was checked against SHAG `4168ec3` and wash-fps `3cba4e0`
(both October 30, 2026; engine `1.0.0-alpha.9.1`, Babylon.js `^9.31.2`).
Paths starting `src/` are in SHAG; the others are in this repository.

---

## Contents

1. [Verdict after round 1](#1-verdict-after-round-1)
2. [What "the client" is](#2-what-the-client-is)
3. [How coupled the code is](#3-how-coupled-the-code-is)
4. [Layer 1: the wire protocol](#4-layer-1-the-wire-protocol)
5. [Layer 2: prediction, reconciliation, interpolation and lag compensation](#5-layer-2-prediction-reconciliation-interpolation-and-lag-compensation)
6. [Layer 3: shared simulation and collision](#6-layer-3-shared-simulation-and-collision)
7. [Layer 4: assets and map formats](#7-layer-4-assets-and-map-formats)
8. [Layer 5: rendering](#8-layer-5-rendering)
9. [Layer 6: audio](#9-layer-6-audio)
10. [Layer 7: input, console, cvars and settings](#10-layer-7-input-console-cvars-and-settings)
11. [Layer 8: HUD, menus and lobby UI](#11-layer-8-hud-menus-and-lobby-ui)
12. [Module to crate map](#12-module-to-crate-map)
13. [Translating TypeScript patterns to Rust](#13-translating-typescript-patterns-to-rust)
14. [Proposed workspace](#14-proposed-workspace)
15. [Milestones and estimates](#15-milestones-and-estimates)
16. [Risks and things to settle](#16-risks-and-things-to-settle)
17. [Next rounds](#17-next-rounds)

---

## 1. Verdict after round 1

It is doable, and the order to do it in is clear. The code splits cleanly into
three kinds:

- **Pure logic that translates almost line for line** (about 22,600 lines): the
  binary protocol, the message codec, game state, snapshot history, clock sync,
  the lobby client, the shared simulation (movement, slide, wall jump, ledge
  grab, swim, ladder, knockback), the collision world, lifts and triggers, demo
  reading, and the entity catalog. None of it imports Babylon or the DOM. This
  is what makes "connects to current servers" realistic: the client and server
  already share this code, so a Rust translation of it is a translation of the
  contract itself.
- **Logic wrapped around Babylon** (about 77,000 lines across SHAG and 24,000 in
  Washoi, in files that import `@babylonjs`): BSP mesh building, Q3 shader
  materials, lighting, effects, weapons, animation, camera. The logic carries
  over; the Babylon calls do not. This needs a new renderer.
- **DOM and CSS UI** (about 30,000 lines of TypeScript touching the DOM plus
  19,600 lines of CSS): HUD widgets, lobby, settings, scoreboard, chat, demos
  browser. None of it carries over as code. The HUD already reads from one data
  layer (`client/HUDState.ts`), so the data side ports and the drawing is new.

One finding resets expectations. The "partial WebGPU path" in SHAG is Babylon's
own `WebGPUEngine` (`src/engine/rendering/RenderingEngineFactory.ts`), plus
WGSL branches inside Babylon material plugins (34 places, for example
`src/engine/loader/bsp/BspBakedLightingPlugin.ts`). Those snippets are fragments
injected into Babylon's StandardMaterial and PBRMaterial shaders, not
stand-alone pipelines. They are a good reference for the math (lightmap layers,
Q3 stage colour, autosprite, soft particles, fog), but the surrounding shader,
the pipelines and the frame graph have to be written from scratch on `wgpu`.

Rough size: a playable "connect, move, shoot, see everyone, basic HUD" client
is about 25 engineer-weeks. Parity with the browser client, without the editor,
is about 55 to 75 engineer-weeks. Section 15 breaks this down.

The first three milestones need no renderer at all, and each one proves part of
the contract against live servers:

1. Decode every snapshot in every recorded `.shagdemo` in Rust and match the
   TypeScript decoder field for field.
2. A headless Rust client that logs into the lobby, joins a match as a
   spectator, and prints the scoreboard.
3. The same client playing: sending 125 commands a second, predicting its own
   movement, and reaching a high "confirmed without replay" count, which is the
   proof that the Rust movement matches the server's.

---

## 2. What "the client" is

The browser application starts in `client/main.ts`. It builds a Babylon engine
and scene, registers Washoi's services with the engine registries
(`client/registerServices.ts`), shows the lobby (`client/LobbyPanel.ts`), and on
`lobby:connect` loads the map and connects to a game server
(`client/FpsMapLauncher.ts`, `client/MatchMapLoader.ts`,
`client/FpsNetworkConnector.ts`).

During a match, the per-frame order lives in `FPSController.update`
(`camera/FPSController.ts`, around line 930):

1. `Game.processSnapshots()`: reconcile the local player against buffered
   snapshots (`client/V2NetworkClient.ts`).
2. `Game.renderRemotePlayers()`: interpolate and draw the other players
   (`client/RemotePlayerRenderer.ts`, `client/FrameEffects.ts`).
3. A fixed 125 Hz command loop: `Game.sendInput()` builds an `FPSInputCommand`,
   predicts it locally and sends it (`Game.ts`, around line 1361).
4. Camera placement with stair smoothing, view effects, weapon view model, HUD.

### In scope for the port

| Area | Where it is today |
| --- | --- |
| Protocol, game state, snapshot history | `src/shared/net`, `src/engine/network` |
| Lobby client (JSON over WebSocket) | `src/lobby/LobbyClient.ts`, `src/lobby/types.ts`, `client/FpsLobbyService.ts` |
| Shared simulation and collision | `simulation/`, `liquid/`, `src/shared/collision`, `src/shared/bsp`, `src/shared/server/simulation`, `src/engine/physics` |
| Prediction and interpolation | `client/V2NetworkClient.ts`, `client/InputHistory.ts`, `src/engine/network/client/*` |
| Assets | `src/engine/loader/{pk3,bsp,shader,texture,model,map}` |
| Rendering | `src/engine/{rendering,lighting,effects,sprites,weapon,animation}`, `liquid/`, parts of `client/` |
| Camera and view effects | `src/engine/{camera,viewport}`, `camera/FPSController.ts` |
| Audio | `src/engine/AudioManager.ts`, `src/engine/audio`, `client/FPS*Audio.ts` |
| Input, console, cvars | `src/engine/{input,console,core}`, `console/` |
| HUD, menus, lobby UI | `src/engine/ui`, `client/hud`, `client/settings`, `client/*View.ts`, `client/Lobby*.ts` |
| Game glue | `Game.ts`, `FPSPlayer.ts`, `world/`, `client/MatchStateManager.ts` |

### Out of scope

The game server, the lobby server and the bot server stay in TypeScript
(`server/`, `src/lobby/LobbyServer.ts`, `bot/`). So do SHAGGED
(`src/engine/editor`, 14,300 lines), the CLI tools, bot training, and the
Electron and Capacitor shells. Demo playback is in scope later; the decoder for
it comes free with milestone 1.

---

## 3. How coupled the code is

Line counts below skip tests and QA probes. "Babylon" counts lines in files that
import `@babylonjs`; "DOM" counts lines in files that touch `document`,
`window`, `HTMLElement` or `localStorage`. A file can be in both.

| Module | Files | Lines | Babylon | DOM | Port style |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/shared/net` | 4 | 2,252 | 0 | 0 | direct |
| `src/shared/server` | 19 | 2,209 | 0 | 0 | direct |
| `src/shared/bsp` | 5 | 1,226 | 0 | 0 | direct |
| `src/shared/collision` | 3 | 603 | 0 | 0 | direct |
| `src/shared/demo` | 6 | 2,212 | 0 | 0 | direct |
| `src/shared/entities` | 7 | 627 | 0 | 0 | direct |
| `src/engine/network` | 37 | 6,201 | 0 | 1,557 | direct (timers become the frame clock) |
| `src/lobby/LobbyClient.ts` | 1 | 568 | 0 | 0 | direct |
| `simulation/` | 13 | 3,135 | 0 | 0 | direct |
| `shared/` (Washoi) | 38 | 2,361 | 0 | 0 | direct |
| `src/engine/physics` | 12 | 3,609 | 3,047 | 0 | direct (Babylon used only for `Vector3`) |
| `src/engine/movement` | 3 | 1,193 | 273 | 913 | direct |
| `src/engine/core` | 28 | 6,995 | 1,149 | 2,779 | mostly direct |
| `src/engine/loader/bsp` | 31 | 8,962 | 6,699 | 192 | parse direct, mesh building re-targeted |
| `src/engine/loader/pk3` | 11 | 3,265 | 1,094 | 2,044 | direct, fetch becomes HTTP + disk cache |
| `src/engine/loader/shader` | 19 | 4,873 | 2,325 | 0 | parser direct, materials rewritten |
| `src/engine/loader/texture` | 12 | 3,740 | 3,420 | 1,544 | decoders replaced by crates |
| `src/engine/loader/model` | 9 | 2,359 | 2,203 | 0 | MD3 parse direct, glTF by crate |
| `src/engine/loader/map` | 9 | 2,687 | 2,238 | 1,568 | re-targeted |
| `src/engine/rendering` | 49 | 10,678 | 10,448 | 2,207 | rewritten on wgpu |
| `src/engine/lighting` | 12 | 2,858 | 2,858 | 0 | rewritten |
| `src/engine/effects` | 12 | 4,247 | 4,019 | 2,128 | logic kept, drawing rewritten |
| `src/engine/sprites` | 5 | 1,571 | 1,488 | 0 | rewritten |
| `src/engine/weapon` | 37 | 12,331 | 11,387 | 285 | logic kept, drawing rewritten |
| `src/engine/animation` | 11 | 2,841 | 2,770 | 0 | rewritten around a skeletal crate |
| `src/engine/camera` | 19 | 3,464 | 2,730 | 1,127 | mostly direct (math) |
| `src/engine/viewport` | 17 | 1,433 | 721 | 0 | direct |
| `src/engine/input` | 7 | 1,518 | 991 | 1,222 | re-targeted to winit |
| `src/engine/AudioManager.ts`, `src/engine/audio` | 3 | 1,163 | 1,161 | 706 | re-targeted to an audio crate |
| `src/engine/console` | 78 | 8,490 | 4,614 | 921 | registry direct, commands case by case |
| `src/engine/ui` | 45 | 11,021 | 311 | 10,615 | rewritten |
| `src/engine/world`, `src/engine/player` | 4 | 1,136 | 925 | 942 | mostly direct |
| `liquid/` | 8 | 1,637 | 1,038 | 0 | sampler direct, visuals rewritten |
| `world/` | 14 | 3,216 | 2,299 | 500 | logic kept |
| `camera/` | 2 | 1,890 | 1,890 | 1,482 | logic kept |
| `console/` (Washoi) | 17 | 1,353 | 241 | 33 | direct |
| `client/` | 138 | 35,173 | 14,005 | 18,291 | split: logic kept, UI rewritten |
| `Game.ts`, `FPSPlayer.ts` | 2 | 2,628 | 2,628 | 2,305 | logic kept |
| **Total in scope** | | **≈168,000** | | | |

The direct-translation rows (the first ten, plus `src/engine/movement`) come to
about 22,600 lines. They are also the rows where a mistake means the server and
the client disagree, which is why they come first and come with parity tests.

---

## 4. Layer 1: the wire protocol

This section is the contract a Rust client has to meet, written from the code.
There are two separate protocols: the lobby (JSON text frames) and the game
server (binary frames). Both run over WebSocket.

### 4.1 Transport and addresses

- **Lobby:** `wss://eu.washoi.net/lobby` and `wss://us.washoi.net/lobby`
  (`washoi.net/src/data/regions.ts`, `scripts/deployment/deploy-eu.sh`). Local
  default `ws://localhost:9000` (`client/FpsLobbyService.ts`). The server is the
  `ws` package with `maxPayload: 64 * 1024` (`src/lobby/LobbyServer.ts:558`).
- **Game servers:** the lobby hands out the URL in `lobby:connect`. It is built
  as `${SHAG_PUBLIC_GAME_PROTOCOL}://${SHAG_PUBLIC_GAME_HOST}:${port}` with ports
  from 7777 upward (`src/lobby/GameServerSpawner.ts:66`). In production that is
  `wss://<region host>:<port>` with real certificates.
- Neither server checks the `Origin` header (no match for `origin` in
  `src/engine/server/network/transport/WebSocketTransport.ts` or
  `LobbyServer.ts`), so a native WebSocket client is accepted as it is.
- The browser transport is `src/engine/network/client/transport/WebSocketTransport.ts`:
  binary frames, `lossless = true`. `WebTransportTransport.ts` exists and is
  never instantiated; AGENTS.md says to keep it as the preferred future
  transport. The Rust transport trait should keep the same shape
  (`send(data, reliable)`, `lossless`) so a QUIC transport can drop in later.

**Rust:** `tokio-tungstenite` with `rustls` and `webpki-roots` for both
connections. The network task runs on its own thread and talks to the frame
loop through channels, which replaces the browser's event callbacks.

### 4.2 Primitive encoding

`src/shared/net/BinaryProtocol.ts`, classes `BinaryEncoder` and `BinaryDecoder`:

| Type | Encoding |
| --- | --- |
| integers, floats | little-endian; `u8 i8 u16 i16 u32 i32 f32 f64` |
| string | `u16` byte length, then UTF-8 bytes |
| bool | `u8`, nonzero is true |

Two details matter for exact compatibility:

- `writeString` coerces `undefined` to `""` and anything else through
  `String()`. Some events still put numeric ids into string fields; on the wire
  they are just text, so Rust reads them as `String`.
- Decoding throws on underflow. Optional trailing fields are read only when
  `decoder.hasMore()`. The Rust decoder needs the same `has_more()` and must
  treat underflow as an error for the whole message.

```rust
pub struct Reader<'a> { buf: &'a [u8], pos: usize }

impl<'a> Reader<'a> {
    pub fn u16(&mut self) -> Result<u16, DecodeError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    pub fn string(&mut self) -> Result<String, DecodeError> {
        let len = self.u16()? as usize;
        Ok(std::str::from_utf8(self.take(len)?)?.to_owned())
    }
    pub fn has_more(&self) -> bool { self.pos < self.buf.len() }
    // u8, i8, i16, u32, i32, f32, f64, bool follow the same pattern.
}
```

### 4.3 Game server messages

`MessageType` in `src/shared/net/BinaryProtocol.ts`; every message starts with
its type byte. Codecs are in `src/engine/network/protocol/MessageCodec.ts`.

| Code | Name | Direction | Payload after the type byte |
| --- | --- | --- | --- |
| `0x01` | Welcome | S→C | `serverId: str, serverName: str, map: str, tickRate: u8, maxPlayers: u8, currentPlayers: u8` |
| `0x02` | JoinAccept | S→C | `clientId: str, playerId: str, entityId: str` |
| `0x03` | JoinReject | S→C | (not handled by the browser client; treat as failure) |
| `0x04` | LegacySnapshot | S→C | refused: "update server and clients together" |
| `0x09` | ServerMessage | S→C | `type: str, message: str` |
| `0x0a` | Pong | S→C | `clientSendTime: f64, serverTime: f64` |
| `0x0b` | Snapshot | S→C | `hasBaseline: u8, baselineTick: u32`, then the raw snapshot (4.4) |
| `0x0c` | ResumeToken | S→C | `token: str, graceMs: u32` |
| `0x81` | Join | C→S | `playerName: str, isBot: u8`, optional `admissionTicket: str` |
| `0x82` | Ready | C→S | empty |
| `0x83` | Input | C→S | the command (4.6) |
| `0x84` | Disconnect | C→S | |
| `0x85` | Ping | C→S | `clientSendTime: f64` |
| `0x86` | JoinGame | C→S | `teamFlag: u8` (0 none, 1 lobby-assigned, 2 picked in game), `teamId: str` if flag > 0, optional `admissionTicket: str` |
| `0x87` | Spectate | C→S | empty |
| `0x88` | RequestSpawn | C→S | empty |
| `0x89` | Chat | C→S | `text: str` (the browser prefixes `/say_team ` for team chat and cuts at 128 characters) |
| `0x8a` | SetLoadout | C→S | `primary: str, secondary: str` |
| `0x8b` | Resume | C→S | `token: str` |
| `0x8c` | ClientPrefs | C→S | `flags: u8`, bit 0 set means "do not auto-switch on pickup" |
| `0x08` | Ack | C→S | `tick: u32` |

`0x05`–`0x07` (PlayerJoined, PlayerLeft, GameStart) are defined but the client
does not handle them.

### 4.4 The connection sequence

From `src/engine/network/client/hosts/NetworkGameHost.ts`:

```text
client                                   game server
  | -- WebSocket open ------------------------> |
  | -- Join(name, isBot=0, admissionTicket) --> |
  | <------------------------------- Welcome -- |  client rejects if tickRate != 125
  | <---------------------------- JoinAccept -- |  local playerId and entityId
  | <--------------------------- ResumeToken -- |  seat is held graceMs after a drop
  | -- ClientPrefs ---------------------------> |  sent after every JoinAccept
  | -- Ping x5, 100 ms apart -----------------> |  then one every 30 s (ClockSync)
  | <------------------ Snapshot (full/delta) -- |  62.5 Hz
  | -- Ack(tick) -----------------------------> |  for every snapshot decoded
  | -- Input x125/s --------------------------> |
  | -- JoinGame(team) ------------------------> |  spectator to player
```

- Snapshots that arrive before both Welcome and JoinAccept are dropped and not
  acknowledged.
- The handshake has a timeout ("Timeout waiting for Welcome and JoinAccept").
- A duplicate JoinAccept is ignored.
- A watchdog checks every 500 ms for snapshots that stop arriving while the
  socket stays open (`ConnectionWatchdog.ts`). On a stall, or on a close
  mid-match, the client reconnects and sends `Resume(token)`, retrying every
  2 s until `graceMs` has passed.
- The music playlists (`data/game.playlist.json`, `data/endgame.playlist.json`)
  switch on match phase inside the network host. In Rust that belongs in the
  game layer, reacting to an event.

**Gap to raise with the server side:** nothing in this handshake carries a
protocol version. The only compatibility check is the tick rate. Today the
browser client and the server ship together, so it does not matter. A native
client that ships on its own schedule would misread a changed layout without
noticing. Section 16 suggests a small, backward-compatible fix.

### 4.5 Snapshots

`MessageCodec.encodeSnapshot` puts a 6-byte envelope in front of the raw format
that demos also record:

```text
[0x0b][hasBaseline: u8][baselineTick: u32]          envelope (SNAPSHOT_HEADER_BYTES = 6)
[tick: u32][serverTimestamp: f64][ackedInputSeq: u32]
[entityCount: u16]  entity × N
[playerCount: u16]  player × N
[eventCount:  u16]  event  × N
[pickupCount: u16][ceil(count / 8) bytes of bits]   optional: read only if bytes remain
```

`hasBaseline` must be 0 or 1, and `baselineTick` must be 0 when `hasBaseline`
is 0. A delta snapshot decodes against the stored snapshot with exactly that
tick, or not at all (`MissingSnapshotBaselineError`).

**Entities.** Every live entity is listed in every snapshot; an entity that is
missing has been removed. Each entry is `id: str, flags: u8`, then the fields
its flags select, in this order:

| Flag | Field | Bytes | When the flag is clear |
| --- | --- | --- | --- |
| `0x01` | position `x, y, z: f32` | 12 | copy from baseline |
| `0x02` | velocity `x, y, z: f32` | 12 | copy from baseline |
| `0x04` | grounded `u8` | 1 | copy from baseline |
| `0x08` | rotation `yaw: f32, pitch: f32` | 8 | copy from baseline |
| `0x10` | movement state, see below | 1 or 5 | copy the four booleans from baseline; the view fields are not carried |
| `0x20` | weapon meta `weaponId: str, settled: u8` | 3+ | copy from baseline |
| `0x40` | powerup mask `u8` | 1 | **no powerups**; never carried, the server sends it every snapshot |

Movement state byte: bit 0 crouching, bit 1 sliding, bit 2 wall jump charging,
bit 3 aiming, bit 7 "view follows". With bit 7 set, four more bytes follow:
keys (bits 0–1 strafe, bits 2–3 forward; 0 none, 1 right or forward, 2 left or
back), slide phase (`u8 / 255`), ledge grab phase (`u8 / 255`), and crouch view
offset (`i8 / 4`).

The server sends the movement state and the powerup mask for every entity that
has them, every snapshot, on purpose: a delta flag that sticks after a baseline
mismatch would leave a player crouched or glowing.

The TypeScript decoder builds loosely typed component maps (`position`,
`transform`, `velocity`, `movementState`, `weaponMeta`, `powerups`) and keeps
both `position` and `transform.position` for older callers. Rust should decode
into one typed struct per entity instead, and keep the carry-forward rules
above exactly:

```rust
pub struct NetEntity {
    pub id: EntityId,
    pub position: Option<Vec3>,       // f32 on the wire; widen to f64 for simulation
    pub velocity: Option<Vec3>,
    pub grounded: bool,
    pub yaw_pitch: Option<(f32, f32)>,
    pub movement: Option<MovementBits>,
    pub view: Option<ViewBits>,       // only from this snapshot's bytes, never the baseline
    pub weapon_meta: Option<WeaponMeta>,
    pub powerup_mask: Option<u8>,     // None means no powerups
}
```

**Players.** Each entry is `id: str, flags: u8`, then: `0x01 entityId: str`,
`0x02 name: str`, `0x04 score: i32`, `0x08 deaths: u32`, `0x10 ping: u16`,
`0x20 team: str`. A clear flag copies the field from the baseline.

**Events.** Each event is `code: u8` plus a fixed layout. Codes 23, 24 and 25
are extended versions of 10 and 4 that decode to the same event type, so old
demos keep decoding:

| Code | Type | Fields |
| --- | --- | --- |
| 1 | `combat_state` | `entityId: str, health: u16, armor: u16, dead: u8` |
| 2 | `match_state` | one JSON string (`MatchStateSnapshot`, `src/shared/server/gametype/GametypeTypes.ts:376`) |
| 3 | `weapon_state` | `entityId, currentWeapon: str, weapons: JSON str, ammo: JSON str, reloading: u8, lastFireTick: u32` |
| 4 | `weapon_fire` | `entityId, weaponId: str, origin xyz f32, dir xyz f32` |
| 24 | `weapon_fire` (seeded) | code 4's fields, then `pelletSeed: i32, pelletSpread: f32` |
| 5 | `weapon_charge` | `entityId, weaponId: str, charging: u8` |
| 6 | `projectile_spawn` | `entityId, defId: str` |
| 7 | `projectile_impact` | `defId: str, xyz f32, normal xyz f32` |
| 8 | `item_pickup` | `pickupId: i16, weaponId, entityId, droppedWeaponId: str, xyz f32` |
| 9 | `weapon_drop` | `entityId, weaponId: str, xyz f32, vel xyz f32` |
| 10 | `damage` | `entityId, attackerId: str, damage: u16, weaponId: str, xyz f32` |
| 23 | `damage` (located) | code 10's fields, then `hitLocation: u8` (0 body, 1 head, 2 legs) |
| 25 | `damage` (pained) | code 23's fields, then `painTier: u8` (0–3) |
| 11 | `death` | `entityId, killerId, weaponId, damageType: str, finalDamage: u16, xyz, vel xyz, kbDir xyz` (all f32) |
| 12 | `award` | `awardType, playerId, playerName, targetName: str, value: u16` |
| 13 | `weapon_chain` | `entityId: str, count: u8`, then `count × xyz f32` |
| 14 | `chat` | `senderId, senderName, team, text: str` |
| 15 | `pickup_notify` | `entityId, label: str` |
| 16 | `voltaic_beam` | `entityId: str`, origin, dir, end, normal (each xyz f32), `impactKind: u8` |
| 17 | `electro_rail` | same layout as 16 |
| 18 | `powerup_state` | `entityId, kind: str, seconds: u16` |
| 19 | `powerup_spawn` | `kind: str, xyz f32` |
| 20 | `agent_directives` | `entityId: str, directives: JSON str` |
| 21 | `lift_state` | `count: u8`, then per lift `modelIndex: u16, offset: f32, phase: u8` (bottom, up, top, down), `remaining: f32, cooldownCount: u8, cooldowns × f32` |
| 22 | `knockback_state` | `entityId: str, ageTicks: u8` (255 means no drag) |

Events are not delta-compressed, and a one-tick event rides only in the
snapshot that carries it. A dropped snapshot loses its events
(`SnapshotReceiver.ts` logs this). Over WebSocket nothing is dropped unless a
baseline is missing.

The four JSON payloads (`match_state`, `weapons`, `ammo`, `agent_directives`)
gain optional fields often. Rust should read them with `serde_json` into
structs where every field is `#[serde(default)]` and unknown fields are
ignored, mirroring the "absent on an older server" comments in
`GametypeTypes.ts`.

### 4.6 Baselines and acknowledgements

`src/engine/network/client/SnapshotReceiver.ts` and `SnapshotBroadcaster.ts`:

- The client keeps the last 128 decoded snapshots (entities and players only)
  keyed by tick, and drops snapshots whose tick is not newer than the latest.
- It sends `Ack(tick)` only for snapshots it decoded. The server deltas against
  an acknowledged snapshot.
- The server forces a full snapshot at least every 64 snapshots per client
  (`FULL_SNAPSHOT_INTERVAL = 64`), so a lost baseline heals within about a
  second at 62.5 Hz.
- History belongs to the connection, not the player's life: clear it on
  reconnect only.

### 4.7 Commands

`BinaryProtocol.encodeCommand` with the `Input` type byte in front:

```text
[0x83][playerId: str][sequence: u32]
[dirX: f32][dirY: f32][dirZ: f32][pitch: f32][yaw: f32]
[buttons: u16][tick: u32][weaponSlot: u8]
```

Buttons (`src/engine/network/components/InputComponent.ts`): FORWARD 1<<0,
BACK 1<<1, LEFT 1<<2, RIGHT 1<<3, JUMP 1<<4, CROUCH 1<<5, SPRINT 1<<6,
WALK 1<<7, FIRE 1<<8, ALT_FIRE 1<<9, RELOAD 1<<10, USE 1<<11, AUTO_ADS 1<<12
(set when fire and aim are both held with auto-ADS on).

What the client has to get exactly right (`Game.sendInput`,
`FPSController.update`):

- **Rate:** exactly 125 commands per second of real time, from a fixed-step
  accumulator capped at 0.25 s. Time dropped by the cap is never sent.
- **Direction:** world-space and already normalised, built in Babylon's
  left-handed, Y-up frame: forward is `(sin yaw, 0, cos yaw)`, right is
  `(cos yaw, 0, -sin yaw)`.
- **Pitch and yaw:** the camera rotation minus the visual weapon kick.
- **`tick`:** the client's view tick, which is the tick of the last snapshot
  received (`gameHost.currentTick`). The server uses it for lag compensation
  (4.9), so it is not decoration.
- **`weaponSlot`:** sent once on the command after a slot key is pressed, then 0.
- **Stripping:** while the match freezes movement, and while dead, the client
  clears the movement and action buttons itself, so prediction agrees with the
  server. While dead, fire or jump sends `RequestSpawn` once the cooldown has
  passed.
- Over a lossless transport each command is sent once. Over datagrams the last
  few are re-sent with each new one (`COMMAND_REDUNDANCY`), and the server skips
  sequences it has seen (`MessageCodec.peekCommandSeq`).

### 4.8 Clock sync

`src/engine/network/client/ClockSync.ts`: simplified NTP. `Ping` carries the
client's `Date.now()`, `Pong` echoes it with the server's `Date.now()`. Offset is
`serverTime - (send + receive) / 2`. A burst of five pings 100 ms apart at
join, one every 30 s after, a rolling window of 16 samples with the slowest
round trips dropped. The snapshot header's `serverTimestamp` is converted with
this offset for interpolation. Rust: `SystemTime` milliseconds as `f64` for the
wire, `Instant` for everything local.

### 4.9 What lag compensation expects from the client

The client does no lag compensation itself; it only has to report its view tick
honestly. On the server, `InputSanitizer.ts` clamps `viewTick` to
`max(0, cmd.tick | 0)`, `GameServer.ts` caps it at the current tick, and
`WeaponSystem.rewindFor` rewinds to `viewTick - interpTicks`, where
`interpTicks` is one snapshot interval (two ticks at 125/62.5 Hz). The rewind
budget is 100 ms (`src/engine/server/lagcomp/config.ts`). The background is in
[v0.9.26-lagcomp-rewind.md](v0.9.26-lagcomp-rewind.md) and SHAG's
`docs/research/lag-compensation-deep-dive.md`.

So a Rust client whose interpolation delay differs from the browser's
(`SnapshotBuffer` settles on the mean plus one standard deviation of arrival
intervals) would have its shots judged against a slightly wrong world. Port
`SnapshotBuffer` as it is, and check it with `npm run net:viewlag`
(`cli/measure-viewlag.ts`), which measures the view lag the server observes.

### 4.10 The lobby protocol

`src/lobby/types.ts`: JSON text frames, `{ "type": "...", ...payload }`.
Clients send `auth` (with a key, or without one to create an account named
`Player_<number>` whose key comes back once in `welcome`), then `queue:*`,
`lobby:*`, `chat:*`, `identity:*`, `settings:*`, `leaderboard:get`,
`stats:get`, `demos:list`, `featured:get` and `match:seat_reissue`. The lobby
answers with `welcome`, `lobby:*`, `matches:update`, `player:*`, `chat:message`
and the matching `*:page`, `*:error` and `*_response` messages.

The message that matters for joining a match is `lobby:connect`:
`{ matchId, serverUrl, map, gametype, admissionTicket }`. The ticket is a
private, single-use seat credential that goes into the game server's `Join` (or
`JoinGame` when dropping into a running match). If it expires before use,
`match:seat_reissue` gets a new one.

In Rust this is an `enum LobbyMessage` with `#[serde(tag = "type")]` and one
variant per message, generated by hand from `types.ts` (728 lines). Requests
that expect an answer carry a `requestId`, as `LobbyClient.ts` does today.

### 4.11 How to prove the Rust decoder right

There is a ready-made corpus: `.shagdemo` files store raw snapshots (no
envelope, no delta) per frame with an index table
(`src/shared/demo/DemoReader.ts`; zlib via `flate2` in Rust). Milestone 1:

1. A small TypeScript tool that reads a demo with `DemoReader` and writes each
   decoded frame as canonical JSON.
2. A Rust tool that decodes the same demo and writes the same JSON.
3. Diff them for every demo on the servers and in `public/data/demos`.

Demos cover full snapshots only. For deltas, add a TypeScript script that
encodes pairs of real frames with `MessageCodec.encodeSnapshot(state, baseline)`
and saves the bytes with the expected decode, then replay those in Rust tests.
The `protocol-change` skill already lists every place a snapshot change touches;
add "regenerate the Rust golden vectors" to it when the Rust client exists.

---

## 5. Layer 2: prediction, reconciliation, interpolation and lag compensation

### 5.1 Local player: `V2NetworkClient`

`client/V2NetworkClient.ts` (1,071 lines) is the heart of "feels the same as
the browser". It runs the same `FPSMovementProfile` as the server
(`simulation/MovementProfile.ts`), keeps every command in `InputHistory`, and on
each snapshot:

1. Reads the server state for the local entity: position, velocity, grounded,
   knockback age (event 22) and lift states (event 21), plus `ackedInputSeq`
   from the header.
2. If the stored prediction for that sequence is within 0.01 units on position
   and velocity, has the same grounded flag, knockback age and lifts, it is
   **confirmed** and nothing is replayed (`confirms()`, top of the file).
3. Otherwise it resets to the server state and replays the unacknowledged
   commands, at most two seconds of them.
4. The visible difference is stored as a visual offset that decays, so a
   correction does not teleport the camera. Snaps of 128 units or more count as
   placements and may turn the view to a spawn facing.
5. Ledge grab and wall jump replays can disagree at sub-tick trace points, so
   some snapshots are suppressed, with hard limits (500 ms of continuous
   suppression, 400 units of divergence).

The constants and rules are all at the top of the file and translate as they
are. The confirmed count on the net graph is the best single parity metric for
the whole Rust simulation: if Rust movement matches the server's, almost every
snapshot confirms.

`NetworkGameHost` still has an older prediction path (`reconcilePrediction`,
`SmoothCorrection`) used when `useExternalPrediction` is false. Washoi always
uses V2, so the Rust port skips the old path.

### 5.2 Remote players: `SnapshotBuffer` and `RemotePlayerLogic`

`src/engine/network/client/SnapshotBuffer.ts` (591 lines) buffers snapshots with
their local arrival time and renders at `now - interpDelay`, interpolating
between the two snapshots around that time and extrapolating from velocity when
the buffer runs dry. The delay follows arrival jitter. Booleans, keys, powerup
mask, water level and ladder are stepped, never interpolated (comments on
`EntitySnapshot`). `client/RemotePlayerLogic.ts` (234 lines) is pure and ports
directly. `client/RemotePlayerRenderer.ts` (2,162 lines) mixes logic with
Babylon meshes and is split during the port: state and animation selection
stay, drawing moves to the renderer.

---

## 6. Layer 3: shared simulation and collision

### 6.1 What runs on both sides

| Piece | Files | Lines |
| --- | --- | ---: |
| Movement profile and sub-systems | `simulation/*.ts` (MovementProfile, Acceleration, Slide, WallJump, LedgeGrab, Swim, Ladder, Knockback, MovementConfig) | 3,135 |
| Liquid sampling | `liquid/LiquidVolumeSampler.ts` and friends | part of 1,637 |
| Collision world | `src/shared/collision/{CollisionWorld,SharedCollisionWorld,WalkFlood}.ts` | 603 |
| Q3 brush trace | `src/engine/physics/SweepCollisionBackend.ts`, `FacetBevels.ts`, `PatchTessellator.ts`, `CollisionSpatialIndex.ts` | about 2,200 |
| Lifts, triggers, spawn points, brush models | `src/shared/bsp/*.ts` | 1,226 |
| Input sanitizing, components, physics constants | `src/shared/server/simulation` | part of 2,209 |
| Movement cvars | `src/engine/movement/MovementVars.ts` | part of 1,193 |

The client wraps the Q3 sweep backend in the same `SharedCollisionWorld` the
server uses (`simulation/collision/BSPCollisionWorld.ts`). The backend imports
Babylon only for `Vector3` (`SweepCollisionBackend.ts:13`), so in Rust it
becomes plain `glam::DVec3` code with no rendering dependency, which also lets
the Rust crate run headless from day one.

### 6.2 Determinism notes

- The simulation runs in double precision on both sides; the wire carries
  `f32`. Rust must simulate in `f64` (`DVec3`), not `f32`.
- JavaScript `Math.sin` and `Math.cos` in V8 come from an fdlibm port. Rust's
  `f64::sin` calls the platform C library, which differs between glibc, macOS
  and Windows in the last bit. The `libm` crate is a port of musl's libm, which
  also descends from fdlibm, so it is the better match. This is an assumption
  to confirm with the parity harness below, not a guarantee. The 0.01-unit
  confirm epsilon gives room, but differences can grow over long airborne
  sequences.
- The simulation uses `Math.sin` 18 times, `Math.cos` 15, `Math.sqrt` 15 (exact
  in IEEE, safe), `Math.abs`, `min`, `max`, `round` and `floor`. `Math.round`
  in JavaScript rounds half up toward positive infinity; Rust's `f64::round`
  rounds half away from zero, so `-2.5` gives `-2` in one and `-3` in the
  other. Use one `js_round` helper that follows the ECMAScript rule wherever
  the TypeScript uses `Math.round` (the naive `(x + 0.5).floor()` is wrong for
  `0.49999999999999994`).
- The only `Math.random` is spawn selection in `FPSSimulation.ts:139`, which is
  server business.
- Movement constants live in cvars (`MovementVars`, `sv_*` and `cl_*`). Most
  are developer-only, so a client never changes the simulation values in
  practice. Check this list in round 3.

### 6.3 Parity harness

SHAG already replays scripted input headlessly:
`npm --prefix src/games/fps run cli:game -- --exec 'sim replay "W+CROUCH 60; JUMP 1; W 30"; quit'`.
Round 3 should extend it to dump position, velocity and movement state per tick
as JSON, then run the same script through the Rust simulation on the same map
and diff tick by tick. Do this for every movement technique in SHAG's
`docs/research/MOVEMENT_TECHNIQUES.md` on the competitive maps.

---

## 7. Layer 4: assets and map formats

### 7.1 Where assets come from

PK3 files (zip archives) are not in any repository. The browser fetches
`data/pk3_manifest.json`, then the content-addressed index it names
(`pk3_index.<sha256>.json`), checks the index's hash and version
(`PK3_INDEX_VERSION = 2`, `src/engine/loader/pk3/PK3PublishedIndex.ts`) and
downloads packages on demand (`PackageDownload.ts`, `PackageStore.ts`), with an
optional mirror (`VITE_PK3_MIRROR_URL`). In production the data is published
next to the game build (`deploy-eu.sh` rsyncs `dist/data/` into the game
release); the exact public URL is to be confirmed in round 4.

A native client does the same over HTTPS (`reqwest`), stores packages in the
user's cache directory (`directories`), and keeps the index hash check. The pk3
lookup order (later packages override earlier ones) is in `PK3Loader.ts` and
`PK3PackageScope.ts` and translates directly; `jszip` becomes the `zip` crate.

### 7.2 Formats

| Format | Used for | TypeScript | Rust |
| --- | --- | --- | --- |
| IBSP (Q3) and FBSP (Warsow) | maps | `loader/bsp/BspLoader.ts` (1,246 lines, no imports but `devLog`) | direct translation over `&[u8]` |
| Q3 `.shader` scripts | materials | `loader/shader/Q3ShaderParser.ts` (1,149 lines, pure) | direct translation |
| MD3 + `.tag` files | items, older models | `loader/model/MD3Loader.ts`, `TagsLoader.ts` | parse by hand (small format) |
| glTF `.glb` | player models, weapons, effects (175 references) | Babylon glTF loader | `gltf` crate |
| TGA | textures | `loader/texture/TgaDecoder.ts` | `image` |
| PNG, JPEG, WebP | textures, levelshots | browser decode | `image` |
| KTX2 (ETC1S, UASTC) | texture sidecars (`r_ktx2`) | Babylon KTX2 decoder worker | `ktx2` + a Basis Universal transcoder to BCn or ASTC |
| KTX1 | some textures | `KTX1Loader.ts` | `ktx` or by hand |
| OGG Vorbis, WAV, MP3 | sounds and music | Web Audio decode | `symphonia` |
| `.shagdemo` | demos | `src/shared/demo/DemoReader.ts` | direct, with `flate2` |
| Playlists, entity defs, prefabs | JSON | various | `serde_json` |

Coordinates: Q3 is Z-up and right-handed, Babylon is Y-up and left-handed, and
SHAG converts once at the loader boundary as `(x, y, z) → (x, z, y)` with
triangle winding reversed (`loader/bsp/mesh/coordinates.ts`). The server works
in the converted frame too, so every position on the wire is in Babylon's frame.
**The Rust client should keep Babylon's frame everywhere** (glam's `_lh`
projection and view functions) instead of converting back to Q3 or to a
right-handed frame. That keeps the wire, the simulation and the translated code
identical and removes a whole class of sign bugs.

---

## 8. Layer 5: rendering

This is the largest single job. The Babylon renderer cannot come along, so the
work is a purpose-built `wgpu` renderer for exactly what Washoi draws.

### 8.1 What the current renderer does

From `src/engine/loader/bsp/BspMeshBuilder.ts` (2,222 lines), the shader
plugins, and SHAG's `docs/research/RENDERING_PIPELINE.md`:

- BSP faces, patches (tessellated), and triangle soups built into batched
  meshes, with spatial batching and PVS culling (`PVSCuller.ts`,
  `loader/bsp/mesh/pvs.ts`).
- Baked lighting: lightmap pages packed into array layers, deluxe maps, vertex
  lighting, the light grid for models (`BspBakedLightingPlugin.ts`,
  `BspVertexLightingPlugin.ts`, `LightGridSampling.ts`).
- Q3 shader stages (`Q3ShaderTypes.ts`): `blendFunc`, `alphaFunc`, `rgbGen`,
  `alphaGen` with waves and distance ramps, `tcMod` (scroll, scale, rotate,
  stretch, turb, transform), `tcGen` (base, lightmap, environment, vector),
  `animMap`, `clampMap`, `depthWrite`, `depthFunc`, `detail`, cube maps, and
  conditional blocks. Animation runs per frame (`ShaderAnimationSystem.ts`) or
  analytically in the shader (`Q3AnalyticAnimationPlugin.ts`).
- Autosprite and autosprite2, soft particles, glow overlays, sky portals and
  sky clouds, fog volumes and atmospheric fog, water with reflections
  (`liquid/`, `src/engine/rendering/water`).
- Dynamic lights from weapons and effects (`lighting/`, `weapon/PointLightPool.ts`),
  clustered on Babylon 9.
- Models: MD3 with tags, skinned glTF with animation groups and blending
  (`animation/`), weapon view model on its own camera.
- Effects: explosions, impacts, muzzle flashes, tracers, rail and voltaic beams,
  gibs, damage numbers, cartoon hit glow, teleport, quad glow, outlines.
- Post-processing (`docs/reference/post-processing.md`): cel outline, optional
  SSR, and others behind `r_*` cvars (`docs/reference/RENDER_VARS.md`).

### 8.2 The Rust renderer

- `wgpu` on Vulkan, Metal and DX12, presented through `winit`.
- WGSL throughout. Start from the WGSL branches already in the material plugins:
  they hold the exact lightmap layer addressing (lightmap U carries
  `u + 2 * layer`), stage colour, autosprite and fog math.
- One pipeline per Q3 stage blend and depth combination, cached by key. Q3
  shaders are data, so the Rust side builds a small stage program per shader at
  load time instead of Babylon's plugin injection.
- A fixed pass list: depth prepass, opaque world, sky, models, translucent
  world and effects (sorted), view model, post-processing, HUD. SHAG's
  `docs/research/babylon-renderer-new-paths-2026-10-26.md` already argues for a
  PVS-driven retained world draw set; that is the natural design here.
- Ragdolls and gibs use Havok through Babylon today (`client/RagdollSystem.ts`);
  `rapier3d` replaces it on the client only.

The groundwork studies for Babylon Lite
(`docs/research/babylon-lite-*.md`, `babylon-classic-to-lite-groundwork-plan-2026-10-26.md`)
already list which renderer data can be separated from Babylon (MD3 and patch
data, visibility queries, weapon motion, input frame ownership, settings
definitions). Most of those packages apply unchanged to a Rust renderer, and
round 5 should start from them.

### 8.3 Visual parity

Use the existing renderer QA probes as references: screenshot the browser
client at fixed camera positions on each map (the `browser-probe` skill), render
the same positions in Rust, and compare. The qfusion parity notes
(`v0.9.30-qfusion-lighting-parity.md`, `v0.9.30-qfusion-material-passes.md`)
describe the intended look.

---

## 9. Layer 6: audio

Today: Babylon AudioV2 on Web Audio (`src/engine/audio/AudioV2Sfx.ts`,
`src/engine/AudioManager.ts`, 1,163 lines) with an SFX bus, cached decoded
buffers read from PK3s, a cap on simultaneous instances, spatial sounds with the
inverse distance model (`spatialDistanceModel: "inverse"`, reference and far
distances and a rolloff from an attenuation preset), music playlists
(`MenuPlaylist.ts`, `data/*.playlist.json`), and about 1,050 lines of
game-specific players (`client/FPS*Audio.ts`, `FPSAnnouncer.ts`). Sounds are
OGG (135 references), WAV (41) and MP3 (6).

Rust: `kira` for mixing, buses, tweens and spatial tracks, with `symphonia`
decoding. Kira's spatial model differs from Web Audio's, so port the inverse
distance gain formula from Web Audio's `PannerNode` by hand and apply it as a
volume, with simple equal-power panning, to keep the same falloff. Check
Babylon's default panning model for AudioV2 spatial sounds in round 6 before
choosing between equal-power and HRTF. The `FPS*Audio` classes are event
handlers and port directly.

---

## 10. Layer 7: input, console, cvars and settings

- **Input:** `src/engine/input/InputSystem.ts` is action-based, with bindings
  stored as DOM `KeyboardEvent.code` strings ("KeyW", "ArrowUp", "Space").
  winit's `KeyCode` is modelled on the same W3C code list, so the bindings and
  saved configs carry over through a name table. Mouse look comes from
  `movementX/Y` under pointer lock; natively it comes from winit's raw
  `DeviceEvent::MouseMotion`, without browser acceleration or pointer lock
  quirks (see SHAG's `linux_mouse_hold.md` and
  `v0.9.31-fullscreen-keyboard-lock.md`). Sensitivity needs one calibration so a
  degree per count matches the browser.
- **Console and commands:** `src/engine/console` (78 files) is a registry with
  commands discovered from `*Command.ts` files. Rust has no file discovery, so
  registration becomes an explicit list (or the `inventory` crate). About half
  the command files touch Babylon (debug and render commands); gameplay and
  network commands port directly.
- **Cvars:** `src/engine/core/Cvar.ts` persists to `localStorage`. Natively,
  write a JSON or TOML file in the config directory, and keep the same keys
  (`engine.movementVars` and so on) so a later import from the browser is
  possible. Settings sync through the lobby (`settings:get`, `settings:save`,
  `src/lobby/SettingsSync.ts`) works unchanged once the lobby client exists.

---

## 11. Layer 8: HUD, menus and lobby UI

All UI is HTML and CSS today: 27 HUD widgets (`client/hud/widgets`), the lobby
(`client/LobbyPanel.ts`, `LobbyRooms.ts`, `LobbyWelcomeDialog.ts`), settings
pages (`client/settings`), scoreboard, chat, demos, leaderboard, profile,
credits, welcome and terms dialogs, and `src/engine/ui`. Every widget implements
`FPSHudWidget` (`getElement`, `update(state)`, `show`, `hide`, `destroy`) and
reads one `HUDState`.

Recommendation: `egui` (with `egui-wgpu` and `egui-winit`) for menus, lobby,
settings and the console, and the HUD drawn by the game renderer's own 2D batch
(text, quads, icons), because the HUD sits over the 3D view every frame and must
look exactly like the browser HUD. Keep the widget interface: each widget
becomes a struct with `update(&HudState)` and `draw(&mut Hud2d)`, so the file
list stays one to one.

The alternative is an embedded web view (`wry`) that reuses the existing HTML,
CSS and TypeScript for the lobby and menus. It saves most of the UI rewrite but
brings a browser engine back into the native client, two languages to debug,
and fragile compositing over a `wgpu` surface on some platforms. Worth a spike
in round 8; not the default.

---

## 12. Module to crate map

| SHAG / Washoi module | Rust module | Main crates | Translation |
| --- | --- | --- | --- |
| `src/shared/net/BinaryProtocol.ts` | `shag_shared::net::binary` | (none) | 1:1 |
| `src/shared/net/{GameState,Entity,Component}.ts` | `shag_shared::net::state` | (none) | 1:1, typed structs replace component maps |
| `src/engine/network/protocol/MessageCodec.ts` | `shag_engine::network::protocol` | (none) | 1:1 |
| `src/engine/network/client/{SnapshotReceiver,SnapshotBuffer,ClockSync,ConnectionWatchdog,NetGraph}.ts` | `shag_engine::network::client` | (none) | 1:1 |
| `src/engine/network/client/hosts/NetworkGameHost.ts` | `shag_engine::network::host` | `tokio`, `crossbeam-channel` | 1:1 minus the legacy prediction path |
| `src/engine/network/client/transport/*` | `shag_engine::network::transport` | `tokio-tungstenite`, `rustls`, `webpki-roots`; later `quinn` or `wtransport` | trait 1:1 |
| `src/lobby/LobbyClient.ts`, `types.ts` | `shag_engine::lobby` | `serde`, `serde_json` | 1:1 |
| `src/shared/server/*` | `shag_shared::server` | `serde` | 1:1 |
| `src/shared/{bsp,collision,entities,demo}` | `shag_shared::{bsp,collision,entities,demo}` | `flate2` | 1:1 |
| `src/engine/physics/{SweepCollisionBackend,FacetBevels,PatchTessellator,CollisionSpatialIndex,ContentFlags}.ts` | `shag_engine::physics` | `glam` (f64) | 1:1 |
| `simulation/`, `liquid/LiquidVolumeSampler.ts` | `washoi::simulation`, `washoi::liquid` | `glam`, `libm` | 1:1 |
| `shared/` (Washoi entities, items, bsp helpers) | `washoi::shared` | `serde` | 1:1 |
| `client/V2NetworkClient.ts`, `InputHistory.ts`, `RemotePlayerLogic.ts` | `washoi::client::net` | (none) | 1:1 |
| `src/engine/core/{EventBus,GameTimer,Cvar,GamePaths}.ts` | `shag_engine::core` | `directories`, `serde` | adapted |
| `src/engine/loader/pk3/*` | `shag_engine::loader::pk3` | `zip`, `reqwest`, `sha2` | 1:1 logic, new I/O |
| `src/engine/loader/bsp/BspLoader.ts` | `shag_engine::loader::bsp` | `bytemuck` | 1:1 |
| `src/engine/loader/bsp/BspMeshBuilder.ts`, `mesh/*` | `shag_engine::loader::bsp::mesh` | `glam` | logic 1:1, output becomes GPU buffers |
| `src/engine/loader/shader/Q3ShaderParser.ts`, `Q3ShaderTypes.ts`, `Q3StageEvaluation.ts` | `shag_engine::loader::shader` | (none) | 1:1 |
| `src/engine/loader/shader/*Plugin.ts`, `Q3ShaderMaterialFactory.ts` | `shag_engine::render::q3` | `wgpu` | rewritten, WGSL math reused |
| `src/engine/loader/texture/*` | `shag_engine::loader::texture` | `image`, `ktx2`, Basis Universal transcoder | replaced |
| `src/engine/loader/model/*` | `shag_engine::loader::model` | `gltf` | MD3 1:1, glTF by crate |
| `src/engine/{rendering,lighting,sprites}` | `shag_engine::render` | `wgpu` | rewritten |
| `src/engine/effects`, `src/engine/weapon` | `shag_engine::{effects,weapon}` | `wgpu` | logic 1:1, drawing rewritten |
| `src/engine/animation` | `shag_engine::animation` | `gltf` | rewritten |
| `src/engine/{camera,viewport}` | `shag_engine::{camera,viewport}` | `glam` | mostly 1:1 |
| `src/engine/input` | `shag_engine::input` | `winit` | adapted |
| `src/engine/AudioManager.ts`, `src/engine/audio` | `shag_engine::audio` | `kira`, `symphonia` | adapted |
| `src/engine/console` | `shag_engine::console` | (none) | registry 1:1 |
| `src/engine/ui`, `client/hud`, `client/settings`, lobby views | `shag_engine::ui`, `washoi::client::hud`, `washoi::client::ui` | `egui`, `egui-wgpu`, `egui-winit` | rewritten |
| `client/RagdollSystem.ts`, `GibSystem.ts` | `washoi::client::ragdoll` | `rapier3d` | rewritten |
| `Game.ts`, `FPSPlayer.ts`, `camera/FPSController.ts`, `world/` | `washoi::game`, `washoi::camera`, `washoi::world` | | logic 1:1 |
| `client/main.ts` | `washoi` binary `main.rs` | `winit`, `tracing` | adapted |

Supporting crates: `tracing` for logs (`devLog` maps to a `developer` filter,
`debugLog(topic)` to targets), `anyhow` and `thiserror` for errors, `puffin` or
`tracy-client` for profiling.

Versions are not pinned here on purpose: pin the current releases of `wgpu`,
`winit`, `egui` and `kira` at the start of milestone 4, because these four move
quickly and must agree with each other.

---

## 13. Translating TypeScript patterns to Rust

| TypeScript in SHAG | Rust |
| --- | --- |
| `X.getInstance()` singletons (`AudioManager`, `CommandRegistry`, `MatchStateManager`, `HUDState`, `CollisionManager`, ...) | One `Client` context struct owns the systems; functions take `&mut` to what they need. Global singletons fight the borrow checker and hide the order that matters. |
| `EventBus` with unsubscribe handles | Typed event queues drained once per frame (`Vec<GameEvent>`), or `crossbeam-channel` across threads. The "always unsubscribe" rule disappears with ownership. |
| Babylon `Observable` | Same as above: an event queue or a returned list of changes. |
| Component maps keyed by string (`entity.getComponent("transform")`) | Typed structs with `Option` fields (see 4.5). |
| Optional fields "absent on an older server" | `Option<T>` and `#[serde(default)]`. |
| String ids for entities and players | An interned id (`Arc<str>`, or a `u32` from a per-connection interner) so maps hash cheaply. The wire stays strings. |
| Duck typing (`typeof sim.spawnPlayer === "function"`) | Traits, or just the concrete type: the Rust client has one simulation. |
| Promises, `background(...)`, `setInterval` | The network and downloads run on a `tokio` runtime; the frame loop polls channels. Timers become checks against the frame clock. |
| Service registries (`GameplayMapLauncher`, `NetworkConnector`, `GameFrameHook`, ...) | Traits implemented by the `washoi` crate and passed to `shag_engine` at startup, which keeps the "engine must not import the game" rule as a crate dependency rule the compiler enforces. |
| `performance.now()`, `Date.now()` | `Instant`, and `SystemTime` milliseconds as `f64` only where the wire needs them. |

The last row deserves a note: SHAG already separates engine and game by
convention and by an audit script (`docs/research/engine-game-split-*.md`). In
Cargo, `shag_engine` simply cannot depend on `washoi`, so the rule becomes free.

---

## 14. Proposed workspace

Keep the folder names so a TypeScript path points straight at its Rust file.

```text
washoi-native/
├─ Cargo.toml                  workspace
├─ crates/
│  ├─ shag_shared/             ← src/shared       (no GPU, no window, no async)
│  │  └─ src/{net,server,bsp,collision,entities,demo}/
│  ├─ shag_engine/             ← src/engine (minus editor, server)
│  │  └─ src/{core,network,lobby,physics,movement,loader,render,lighting,
│  │          effects,weapon,animation,camera,viewport,input,audio,console,ui}/
│  ├─ washoi/                  ← wash-fps (client side)
│  │  └─ src/{simulation,liquid,shared,world,camera,console,client,game.rs,fps_player.rs,main.rs}
│  └─ tools/
│     ├─ proto_dump/           demo and golden-vector decoder (milestone 1)
│     ├─ headless_client/      lobby + match client without a window (milestones 2–3)
│     └─ sim_parity/           tick-by-tick movement diff against `sim replay`
└─ reference/                  SHAG checkout with wash-fps at src/games/fps, pinned
```

`shag_shared` stays free of GPU and async code so it can later serve a Rust
game server or a WebAssembly build without changes.

Where the code lives is still open (section 16). A separate repository keeps the
Rust toolchain and CI apart from the TypeScript gates, and pins the TypeScript
it was translated from as a submodule, the same way SHAG pins wash-fps today.

---

## 15. Milestones and estimates

Estimates are engineer-weeks for one developer who knows Rust and this codebase,
including tests. They are round-1 guesses from line counts and coupling, not
measured; each later round should revise its own layer.

| # | Milestone | Proves | Weeks |
| ---: | --- | --- | ---: |
| 0 | Workspace, CI, reference checkout, TypeScript golden-vector scripts | the harness exists | 1 |
| 1 | `shag_shared::net` + `MessageCodec`: decode every demo and every delta vector identically | the wire format | 2 |
| 2 | Headless client: lobby auth, `lobby:connect`, game handshake, acks, clock sync, watchdog, resume; joins as spectator and prints the scoreboard | live servers accept us | 2–3 |
| 3 | BSP parse, collision, lifts, triggers, liquid, the full movement profile; `sim_parity` clean on all maps | the simulation matches | 4–6 |
| 4 | `V2NetworkClient`, `InputHistory`, `SnapshotBuffer`; headless client plays with scripted input and mostly confirms | prediction matches the server | 2 |
| 5 | PK3 index and downloads, cache, textures (incl. KTX2), Q3 shader parser, MD3, glTF, sounds | assets load natively | 3–4 |
| 6 | Window, input, camera; renderer v1: world with lightmaps, opaque and blended Q3 stages, sky, PVS | you can fly around a map | 6–8 |
| 7 | Players and weapons: skinned models and animation, view model, projectiles, hitscan and beam effects, explosions, dynamic lights | a match is watchable | 6–8 |
| 8 | Audio: SFX, spatial falloff, music playlists, announcer, all `FPS*Audio` | a match sounds right | 2–3 |
| 9 | Minimal HUD (vitals, ammo, crosshair, frags, timer, chat, scoreboard) and a minimal lobby screen | **playable MVP** | 3–4 |
| 10 | Full lobby, settings, console, cvars, settings sync, profile, leaderboard | the menus are complete | 6–8 |
| 11 | Remaining visuals: water, fog volumes, soft particles, glow, post-processing, gibs and ragdolls, quad glow, outlines | visual parity | 6–10 |
| 12 | Demo playback, highlight reels | demos | 3–4 |
| 13 | Packaging, signing, updates, crash reporting for Windows, macOS, Linux | shippable | 2–3 |

- **Playable MVP (milestones 0–9):** about 31 to 41 weeks as listed; with
  milestones 6 and 7 cut to "world plus coloured capsules for players, basic
  effects", about 25 weeks.
- **Parity without the editor (0–13):** about 48 to 66 weeks, plus about 15 per
  cent for the unknowns every port has, which lands at the 55 to 75 weeks in
  section 1.
- Work split for two people: one on milestones 1–4 (protocol and simulation),
  one on 5–7 (assets and renderer), meeting at 9.

---

## 16. Risks and things to settle

1. **No protocol version (high).** A native client released on its own schedule
   can misread a changed snapshot. Smallest fix, in the style the codec already
   uses: an optional trailing `protocolVersion: u16` on `Join` and on `Welcome`,
   absent meaning "browser, same build". The server can then refuse a stale
   native client with a clear `ServerMessage`. This is a server change and
   needs the `protocol-change` checklist.
2. **Simulation parity (high).** Covered by milestone 3's harness and the libm
   choice in 6.2. Until it is clean, the native client will feel worse than the
   browser, not better.
3. **Renderer scope (high).** The Q3 shader corpus on the current maps decides
   how much of 8.1 is needed. Round 5 should count the stage features actually
   used by the shipped pk3s, so unused features are not built.
4. **Protocol churn while porting (medium).** The protocol changed often during
   0.9 (codes 23–25, view bytes, lift and knockback state). Golden vectors
   regenerated in CI on every SHAG change will catch drift on the day it happens.
5. **Anti-cheat stance (medium).** A native client is easier to modify than the
   browser build is today. The server is authoritative and validates movement
   (`server/MovementValidator.ts`, `server/AuthorityGuards.ts`), so this mostly
   affects aim and wallhacks. Settle the policy before a public release, not now.
6. **Lobby and terms (low).** Accounts are key plus name; `welcome` carries a
   new key once. The native client must store it as the browser does and show
   the same terms and policy acceptance (`policyVersion`).
7. **Where the code lives (decision).** A new repository with the TypeScript
   pinned as a reference (recommended), or a `native/` folder in wash-fps.

---

## 17. Next rounds

| Round | Layer | Questions to answer |
| --- | --- | --- |
| 2 | Protocol, function level | Full Rust type definitions for `GameState`, all events and `MatchStateSnapshot`; the golden-vector scripts written out; the lobby message enum; the exact JoinReject and ServerMessage cases the server sends |
| 3 | Simulation | Each movement file mapped function by function; every cvar that reaches the simulation; the `sim replay` JSON dump format; a check of `libm` against V8 on recorded inputs |
| 4 | Assets | The production data URL and caching headers; pk3 index entries in detail; which texture and model formats the shipped pk3s actually contain, by count |
| 5 | Renderer | Q3 stage features used by shipped maps; pass list and pipeline keys; the WGSL fragments lifted into stand-alone shaders; which Babylon Lite groundwork packages apply |
| 6 | Audio | Babylon AudioV2 defaults (panning model, distances), the attenuation presets, the bus layout |
| 7 | Input and console | Binding name table against winit; which console commands a player can use; cvar file format |
| 8 | UI | HUD widget inventory with each widget's `HUDState` inputs; egui versus web view spike |
| 9 | Game glue | `Game.ts` and `FPSController.ts` split into Rust modules; the frame order written down as code |

