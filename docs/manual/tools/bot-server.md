# Bot Intelligence Server

Bots in Washiki Washoi run as a **separate Node.js process** that connects to game servers as real WebSocket clients. At the protocol level, a bot is indistinguishable from a human player.

The bot system lives at `src/bot/` in the engine repo (not in this submodule).

## Running

```bash
npm run bot:server
```

The bot server boots an interactive console. It can register itself with a lobby, queue for matches like a human player, and play autonomously.

### The lobby and the shared secret

The lobby, the bot server and the game servers run on one machine and share a secret:
- **Where it comes from:** `BOT_SECRET` when it's set. Otherwise the first process to start writes one to `<data-dir>/bot-secret` (the data directory is `--data-dir`, else `SERVER_DATA_DIR`, else `server-data/` at the repo root). Start both from the same folder, or give them the same `--data-dir`.
- **The control port:** the lobby sends the secret when it asks for a bot. The bot server's control port (9100) listens on `127.0.0.1` only and closes any connection without it.
- **Bot logins:** lobby bots log in with the secret. The lobby treats a connection as a bot only with the secret, from its own machine. Bots have no player account, and players can't take a bot's name.

## Architecture

| Component | Responsibility |
|-----------|----------------|
| `BotServer.ts` | Top-level orchestrator; manages a fleet of bot clients |
| `BotClient.ts` | A single headless network client; one per bot |
| `BotBrain.ts` | AI base class; subclassed for different difficulty / strategy |
| `BotGameState.ts` | Parses incoming snapshots into a queryable world model |
| `BotVision.ts` | BSP raytracing — line-of-sight, cover evaluation, spatial awareness |
| `BotNavGraph.ts` | A* pathfinding on a BSP-derived Smart Waypoint Network |
| `BotConfig.ts` | Difficulty presets; hands out bot names; default goal-arbiter mode |
| `BotNames.ts` | Bot name pool, reserved from players by the lobby |
| `BotMovementProfile.ts` | Knowledge of movement mechanics (strafe jump, wall jump, etc.) |
| `BotMovementAnalyzer.ts` | Reads back what the movement actually did |
| `BotWeaponProfile.ts` | Knowledge of weapon stats |
| `BotFireSafety.ts` | Refuses shots that would hurt the bot or a teammate |
| `BotNavCache.ts` | Caches the derived navigation graph per map on disk |
| `BotSequence.ts`, `sequences/` | Multi-tick manoeuvres: strafe-jump routes, crouch-slides, jumppads, teleporters, validated jumps |
| `goals/` | Goal sources, considerations and the arbiter that scores them |
| `StateMachineBrain.ts` | The rule-based brain |
| `HybridBrain.ts`, `TFBackend.ts` | The optional neural brain and its backend |
| `BotInputNormalizer.ts` | Converts game state to neural-network input vectors |
| `BotEpisodeRecorder.ts` | Records training episodes |
| `BotRewardComputer.ts` | Computes reinforcement-learning rewards |
| `BotTrainer.ts` | Autonomous self-play training loop |
| `DemoTrainingExtractor.ts` | Turns a `.shagdemo` recording into training frames |
| `BotLobbyClient.ts` | Lobby integration — bots join rooms and ready up like humans |

## Difficulty Tiers

Four presets in `BotConfig.ts`, each a set of skill dials rather than a single
number. The values below are the committed presets; `aimAccuracy` and the other
skills run 0 to 1, and `mistakeRate` is how often a bot is allowed to be wrong.

| Preset | Aim | Reaction | Tracking | Prediction | Item timing | Strafe jump | Dodge | Mistakes |
|--------|----:|---------:|---------:|-----------:|------------:|------------:|------:|---------:|
| Easy | 0.25 | 450 ms | 1.5 | 0.2 | 0.1 | 0.1 | 0.15 | 8 |
| Medium | 0.5 | 280 ms | 3.0 | 0.5 | 0.4 | 0.4 | 0.4 | 3 |
| Hard | 0.75 | 150 ms | 5.0 | 0.75 | 0.7 | 0.7 | 0.7 | 1 |
| Insane | 0.92 | 60 ms | 8.0 | 0.9 | 0.9 | 0.9 | 0.9 | 0.2 |

Read the preset in source rather than a percentage here: these are the numbers
the bot is actually built from.

## Two AI Modes

`BotBrain` is the interface; two brains implement it.

1. **`StateMachineBrain`** — the rule-based brain, always available. What it
   wants at any moment comes from the **goal layer** in `goals/`: goal sources
   propose candidates (acquire an item, hunt, hold an area, defend, escort,
   move to a place), each is scored by considerations, and `GoalArbiter` picks
   one. It combines them as `gate × attraction × discount`, taking the best
   reason rather than summing every reason, so a goal that is mediocre at
   everything cannot outscore a goal that is decisive about one thing. The
   arbiter's mode comes from `BOT_GOAL_ARBITER`: on by default, `legacy` to
   fall back to the older scoring, `verbose` to have it explain itself.
   Movement that takes more than a tick — a strafe-jump route, a crouch-slide
   into an item, a jumppad or teleporter traversal — runs as a **sequence**
   from `sequences/`, which the brain can interrupt.
2. **`HybridBrain`** — optional TensorFlow.js networks layered on the rules.
   Inputs come from `BotInputNormalizer`; outputs influence move, aim and fire.

The neural mode is opt-in per bot. Without it, bots run the rules and the goal
layer, and play competitively at Medium and Hard.

## Training Pipeline

The bot server can run an autonomous self-play training loop:

1. Spawn N bot clients against each other in a controlled match.
2. Record episodes (state + action + reward per tick) via `BotEpisodeRecorder`.
3. After the match, compute rewards via `BotRewardComputer` and update the neural network weights.
4. Repeat indefinitely.

Saved model weights persist between runs. Match demos are training data too:
`DemoTrainingExtractor` reads a `.shagdemo` recording and produces per-player
frames through the same `BotInputNormalizer` the live bots use.

## Joining a room

The lobby flow is live: `BotLobbyClient` connects to the lobby with the shared
secret, and either queues like a human or joins one exact room when the lobby
hands it a room id and, for a private room, that room's invite token. It then
readies up on its own. From the room's side this is the Add bot key; from the
lobby's side it is an invitation acknowledged only once the bot is actually
seated.

## TODO

- Per-difficulty weapon profile overrides
- Configuration file format
- Logging + telemetry expectations
- Production deployment patterns
