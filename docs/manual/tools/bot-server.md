# Bot Intelligence Server

Bots in Washiki Washoi run as a **separate Node.js process** that connects to game servers as real WebSocket clients. At the protocol level, a bot is indistinguishable from a human player.

The bot system belongs to this game repository at `bot/`; in an assembled SHAG
checkout that is `src/games/fps/bot/`. Its CLI is `cli/bot-server.ts`. Run commands
from the assembled root so data, model and navigation-cache paths resolve there.
The game-owned server build recipe produces `dist-server/bot-server.mjs`.

Examples below start at the SHAG root. From `src/games/fps` you can instead use
`npm run bot:server`; the launcher still uses the SHAG root as cwd. Dependencies
are installed once at the SHAG root. `bot:server` builds its bundle before
launching Node; `bot:server:dev` runs the source through `vite-node`.

The optional neural backend still uses the assembled root's TensorFlow
installation and Windows native-library fixup. Moving the source does not change
the native-first/pure-JavaScript fallback or the model format.

## Running

```bash
npm --prefix src/games/fps run bot:server
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

Bot map loading uses the pk3 index in `public/data/` and `dist/data/` relative to
the assembled root. Packages must contain the requested map. Missing maps or
rejected published builds leave bot vision unavailable and log the loading error.
Standalone BSP files are not a fallback for indexed loading.

Bot map knowledge uses the same spawn-point extractor as the game server,
including generic and team-tagged spawn entities. Whitespace-separated origins
are accepted; nonfinite or incomplete positions are skipped. Maps with no usable
spawns use the server's three fallback positions.

Each `BotClient` owns one connection attempt. Retrying or rejoining creates a
fresh client with the desired bot options. Failed attempts, disconnect and
disposal consume the instance; a later `connect()` call is rejected before a
socket is opened. The lobby retry loop already creates fresh clients. Map and
navigation caches remain shared by `BotServer`.

Each playing bot sends paced input through its own timer. An explicit
disconnect, socket close or socket error stops that timer.

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

| Preset | Aim | Reaction | Tracking | Prediction | Item timing | Strafe jump | Dodge | Mistakes | Match sense |
|--------|----:|---------:|---------:|-----------:|------------:|------------:|------:|---------:|------------:|
| Easy | 0.25 | 450 ms | 1.5 | 0.2 | 0.1 | 0.1 | 0.15 | 8 | 0 |
| Medium | 0.5 | 280 ms | 3.0 | 0.5 | 0.4 | 0.4 | 0.4 | 3 | 0.45 |
| Hard | 0.75 | 150 ms | 5.0 | 0.75 | 0.7 | 0.7 | 0.7 | 1 | 0.8 |
| Insane | 0.92 | 60 ms | 8.0 | 0.9 | 0.9 | 0.9 | 0.9 | 0.2 | 1 |

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
time first, drawn log-normal round it as people's are (one wait in ten is a third
longer, one in a hundred nearly twice as long), and some of those turns overshoot
by 4–12% and come back: about one in six at full aim accuracy, two in five on
Easy. The aim error wanders slowly, about once a second, with the
spread the old per-decision noise had. Movement follows the wanted heading at
once, so a bot never runs where its view happens to point mid-turn. While
walking a route the bot looks about 250 units ahead along it; in a jump pad's
flight, and stepping onto a pad or teleporter, it keeps its view rather than
turning to a landing spot it is passing over. Scripted moves (learned routes,
validated jumps) set the view exactly and bypass all of this.

A learned route (a trick recorded by a player and checked by `bot:learn`) is a
script from standing on a mark: a sprint run-up, then the trick. Where the ground
behind the mark is walkable, a bot runs in along the route's line instead of
stopping on it, and takes over the script at the run-up state it matches in
place, speed and heading (`sequences/FlyingStart.ts`). It joins only once the
game's own movement, simulated from where the bot will be when the script
arrives (two to five ticks later), lands the rest where the route lands; else,
or when the run-in misses, it walks to the mark and stops as before.

Out of a fight with no enemy in sight (running for an item, hunting, retreating,
or chasing someone it can no longer see) a bot is calm: there is nothing to
react to, so its view eases toward where it wants to look, at most 120°/s,
ignores changes under five of the deadzones above, and rests about 10° below
level, at the floor ahead. A turn of more than 90° is a turnaround and goes the
ordinary way: the reaction wait, then a fast turn. Between glances the view
rests on the route ahead; every 2–4 s the bot glances for about 0.7 s toward a
clearly more open direction within 45° of where it runs. Recorded people look
like this: out of a fight their view turns about 35°/s while their movement
weaves under it (`bot:demo-motion`, [Bot training](./bot-training.md)).

### What a bot knows

A bot knows what it sees and what it hears, not everything the server sends
(`BotPerception.ts`). It sees enemies in line of sight within 55° of its view
(70° for fast movers). It hears shots (1200 units; rockets, grenades, the
electrobolt 2000), explosions (1500), footsteps (500), jumps (720), pain (800)
and pickups (900; armour, mega and powerups 2500). Footsteps and jumps are heard
when a player's client would play them (on the ground faster than 70 u/s and not
sliding; leaving the ground faster than 60 u/s up), as far as they still play at
an eighth of full volume under the game's sound falloff. A landing makes no sound
of its own; one that hurts is heard as pain. A heard enemy is known where the sound came from. A heard major pickup is
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
  plasma; after a slow gun's shot, the other gun carried while the slow one
  reloads (an electrobolt into the machinegun or riotgun), when it fits the
  distance and fires at least 0.25 s sooner; and the gun for a heard enemy's
  distance readied before they appear.
- **Firing on aim** (`BotFireSafety.ts`): fire waits until the view is within 12°
  of the aim, so a bot turns round before it shoots.
- **Moods and mistakes** (`BotMood.ts`): confident after two kills, tilted after
  three deaths (looser aim, slower reactions), cautious on low health or against
  an enemy with armour or a powerup. Each fight may carry one mistake at
  `mistakeRate / 16` odds.

### How a bot plays to win

Each decision the brain updates a read of the match (`strategy/MatchRead.ts`)
from what the bot perceived: its own health and armor over time; an estimate
of each enemy's, from spawn values, the hits it lands (armor takes 66% of a hit
while it lasts), the pain tier each hit gives away and the major items the enemy
was seen or heard taking; who took the major items; each fight and how it ended;
and the score. Every second the strategist (`strategy/Strategist.ts`) names
what is going on and picks a strategy for it, held at least 6 s:

| Diagnosis | When | Strategy |
| --- | --- | --- |
| Understacked | Fights started well under the enemy's stack, or a fresh estimate 40 or more above its own | Recover: retreat sooner, shop for items even armoured, no chasing, danger felt more |
| Losing the items | Opponents took most of the major items in the last 90 s | Control: lead the timed items, value them and their denial more |
| Enemy weak | A fresh estimate under 70 while its own stack is 100 or more | Pressure: retreat later, shop less, more aggression |
| Focused | Two or more enemies hurt it in the last 20 s | Recover |
| Ahead late | 2 or more frags up with under 90 s left | Protect lead: take no risks, stay stacked |
| Behind late | 2 or more down with under 90 s left | Pressure |

A strategy is data: multipliers on the gametype's weight profile, which the
goal arbiter scores items with, and a stance for the state machine (retreat
line, how readily it shops, whether it chases). The rules still play every
command. `matchSense` sets how much of this a bot does: Easy none, Medium only
Recover and Protect lead, Hard and Insane all of it. At 0.6 and above the bot
also adapts within the match: each diagnosis has two strategies that can answer
it, and a bandit keeps how each paid off against this opponent (the score gap,
the major item balance and its stack over the next 30 s), playing what has
worked and now and then trying the other. It learns the opponent's habits too
(`strategy/OpponentModel.ts`): a major item an opponent took twice in the last
three minutes becomes contested, and the goal arbiter scores being there first
by the profile's `itemDenial` (`goals/considerations/ContestedItem.ts`).

With a fresh estimate saying one hit would kill, a bot switches to the hitscan
gun that does it at that distance (`BotWeaponCombos`), rolled at its prediction
skill.

A strategy that fades (Recover, Protect lead) leaves a fight once it has
taken 40 damage in it without a stack advantage by the estimate, and a bot
retreating from an enemy in sight first heads for the nearest route node, 192
to 900 units away and not toward the enemy, that the enemy cannot see, then for
health.

Bots learn across matches through a baseline, not through memory of anyone.
At the end of each match a bot hands in a report (map, gametype, preset,
score, its fights by 256-unit map cell and whether against a person or a bot,
and each strategy episode with its payoff); the bot server keeps them in
`<data-dir>/bot-intel.db` (`--no-intel` to keep none) for 90 days.
`npm --prefix src/games/fps run bot:intel` distils them, on demand, into
`config/bot-intel/<map>.json`: per gametype, how fights went in each cell and
what each strategy paid for each diagnosis. Review and commit it like a route
library. Bots read the payoffs as the bandit's starting estimates once an arm
has 10 episodes in it, and the file is part of the behaviour fingerprint.

`BOT_GOAL_ARBITER=verbose` logs each change of strategy and its reason. The bot
options `strategy: false` (no strategist whatever the preset) and `habitItem`
(go for every item of one kind, the predictable opponent a strategist should
exploit) exist for head-to-head tests with `bot:ab`.

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
   Out of a fight a bot under 50 health or out of ammo goes for items; one
   with 25 armor or more hunts. Under 25 armor it runs its item cycle while it
   has no idea where an enemy is, and with an enemy to hunt it shops only for
   an item the arbiter scores at least `0.2 + 0.25 × aggression`, where
   `aggression` comes from the gametype's weight profile: Duel (0.5) shops for
   most items, Deathmatch (0.8) for the good ones only.
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
