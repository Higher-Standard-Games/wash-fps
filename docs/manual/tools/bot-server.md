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
- **Bot logins:** lobby bots authenticate with the shared service secret, not a
  human account key. Standard difficulty presets have rating identities for
  private matches. Players cannot claim a bot's reserved name.

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

### How a bot turns

The brain decides where to look about 30 times a second; the client turns the
view there over the commands it sends (`BotAimController.ts`), so a bot turns
like a hand on a mouse rather than snapping to each decision. Its speeds come
from the preset's tracking, reaction and aim values:

| Preset | Top turn speed | Settle time | Ignores changes under |
|--------|---------------:|------------:|----------------------:|
| Easy | 150°/s | 0.41 s | 4° |
| Medium | 300°/s | 0.29 s | 3° |
| Hard | 500°/s | 0.22 s | 2° |
| Insane | 800°/s | 0.18 s | 1.5° |

Pitch turns at 60% of these speeds. A bot that is firing tracks every change and
follows its target's motion. A turn over 45° waits for the preset's reaction
time (±20%) first. The aim error wanders slowly, about once a second, with the
spread the old per-decision noise had. Movement follows the wanted heading at
once, so a bot never runs where its view happens to point mid-turn. While
walking a route the bot looks about 250 units ahead along it; in a jump pad's
flight, and stepping onto a pad or teleporter, it keeps its view rather than
turning to a landing spot it is passing over. Scripted moves (learned routes,
validated jumps) set the view exactly and bypass all of this.

### What a bot knows

A bot knows what it sees and what it hears, not everything the server sends
(`BotPerception.ts`). It sees enemies in line of sight within 55° of its view
(70° for fast movers). It hears shots (1200 units; rockets, grenades, the
electrobolt and instagun 2000), explosions (1500), running footsteps (500),
jumps and landings (800), pain (800) and pickups (900; armour, mega and powerups
2500). A heard enemy is known where the sound came from. A heard major pickup is
timed, with an error that shrinks with item-timing skill, and the bot is back at
the spot when it should return, watching the ways in. An item taken out of sight
and earshot is still believed there until the bot looks at its spot.

### How a bot fights

- **Movement** (`BotCombatMovement.ts`, by dodge skill): strafe runs of 0.25–0.9 s
  with double-backs, a jump or slide after a hit, a sidestep (and jump) off an
  incoming rocket or grenade after the reaction time, hops at range for
  strafe-jumpers, and a nearby ledge above the enemy with a splash weapon.
- **Slide-blade lunge** (`SlideBladeSequence.ts`): from a run at slide speed, an
  enemy 200–450 units ahead is closed in one crouch-slide with the blade.
- **Combos** (`BotWeaponCombos.ts`, by prediction skill): a launching rocket into
  the electrobolt or riotgun, a point-blank rocket into the blade, a rail between
  plasma; and the gun for a heard enemy's distance readied before they appear.
- **Moods and mistakes** (`BotMood.ts`): confident after two kills, tilted after
  three deaths (looser aim, slower reactions), cautious on low health or against
  an enemy with armour or a powerup. Each fight may carry one mistake at
  `mistakeRate / 16` odds.

### Chat

Bots say the odd line to humans (`bot/chat/`): "gl hf" as the match goes live,
something cheeky after killing a human (a blade show-off or a streak taunt among
them), gracious or mad after being killed by one, a sulk after three deaths in a
row, and "gg" in the last 30 seconds. The lines are English with a few Finnish
ones. Each bot's name sets how chatty it is and how sore a loser. Lines are about
humans only, so bot-only matches stay quiet. Each bot says at most one line per
20 s, all bots on a bot server at most one per 5 s, and each line arrives
0.8–2.5 s after its moment, as if typed. Set `BOT_CHAT=0` on the bot server to turn it off; training
runs always have it off.

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

## Training

Two sources, one set of labels. Recorded human matches are where playing like a
person comes from; self-play sharpens what is already there. Both are covered in
[Bot Training](./bot-training.md), including what a demo has to hold to be worth
training on, how a corpus is built, and how trained weights reach a bot in a
room.

The short version: `--models <dir>` tells the bot server where the weights are,
and every bot it creates inherits that directory — including a bot a player adds
from a room. A bot whose models will not load plays the rules.

## Joining a room

The lobby flow is live: `BotLobbyClient` connects to the lobby with the shared
secret, and either queues like a human or joins one exact room when the lobby
hands it a room id and, for a private room, that room's invite token. It then
readies up on its own. From the room's side this is the Add bot key; from the
lobby's side it is an invitation acknowledged only once the bot is actually
seated.

The player-facing **Add bot** action works in any waiting room; bots play only in private rooms, so in a public room it makes the room private first. Without
an explicit preset, the lobby chooses one near the player's private rating for
that mode; new players fall back to medium. Standard presets have rating accounts
used by the private ladder. A bot client still authenticates with its service
secret, not a human account key; see [Ranked matches](../multiplayer/lobby.md#ranked-matches).

## TODO

- Per-difficulty weapon profile overrides
- Configuration file format
- Logging + telemetry expectations
- Production deployment patterns
