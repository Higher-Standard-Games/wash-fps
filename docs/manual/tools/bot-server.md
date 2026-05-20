# Bot Intelligence Server

Bots in Washiki Washoi run as a **separate Node.js process** that connects to game servers as real WebSocket clients. At the protocol level, a bot is indistinguishable from a human player.

The bot system lives at `src/bot/` in the engine repo (not in this submodule).

## Running

```bash
npm run bot:server
```

The bot server boots an interactive console. It can register itself with a lobby, queue for matches like a human player, and play autonomously.

## Architecture

| Component | Responsibility |
|-----------|----------------|
| `BotServer.ts` | Top-level orchestrator; manages a fleet of bot clients |
| `BotClient.ts` | A single headless network client; one per bot |
| `BotBrain.ts` | AI base class; subclassed for different difficulty / strategy |
| `BotGameState.ts` | Parses incoming snapshots into a queryable world model |
| `BotVision.ts` | BSP raytracing — line-of-sight, cover evaluation, spatial awareness |
| `BotNavGraph.ts` | A* pathfinding on a BSP-derived Smart Waypoint Network |
| `BotConfig.ts` | Difficulty presets + bot name pool |
| `BotMovementProfile.ts` | Knowledge of movement mechanics (strafe jump, wall jump, etc.) |
| `BotWeaponProfile.ts` | Knowledge of weapon stats |
| `BotInputNormalizer.ts` | Converts game state to neural-network input vectors |
| `BotEpisodeRecorder.ts` | Records training episodes |
| `BotRewardComputer.ts` | Computes reinforcement-learning rewards |
| `BotTrainer.ts` | Autonomous self-play training loop |
| `BotLobbyClient.ts` | Lobby integration — bots queue + ready-up like humans |

## Difficulty Tiers

Configurable via `BotConfig.ts`. Each tier tunes aim accuracy, reaction time, tracking speed, and mistake rate:

| Tier | Aim | Reaction | Tracking | Mistakes |
|------|-----|----------|----------|----------|
| Easy | ~70% | slow | jerky | frequent |
| Medium | ~85% | medium | smooth | occasional |
| Hard | ~95% | fast | tight | rare |
| Insane | ~99% | near-instant | predictive | almost never |

## Two AI Modes

The bot brain has two layers:

1. **Rule-based state machine** (`BotBrain`). Priority-ordered states: `fight → hunt → retreat → chase → dodge → item_run`. Always active.
2. **Optional TensorFlow.js neural networks** (`HybridBrain`). Two networks (tactical + combat) layered on top of the rules. Inputs come from `BotInputNormalizer`; outputs influence move + aim + fire decisions.

The neural mode is opt-in per bot. Without it, bots run pure rules and play competitively at Medium / Hard.

## Training Pipeline

The bot server can run an autonomous self-play training loop:

1. Spawn N bot clients against each other in a controlled match.
2. Record episodes (state + action + reward per tick) via `BotEpisodeRecorder`.
3. After the match, compute rewards via `BotRewardComputer` and update the neural network weights.
4. Repeat indefinitely.

Saved model weights persist between runs. Match demos (`.shagdemo`) can also be fed in as training data — see the [introduction](../introduction/index.md#whats-coming).

## TODO

- Lobby flow: `bot:lobby` mode that queues bots into normal matches alongside humans
- Per-difficulty weapon profile overrides
- Configuration file format
- Logging + telemetry expectations
- Production deployment patterns
