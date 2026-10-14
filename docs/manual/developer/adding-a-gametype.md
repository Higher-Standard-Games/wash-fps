# Adding a Gametype

A gametype is a class that extends `BaseGametype` (`server/gametypes/BaseGametype.ts`). It declares rules and reacts to events; the `GametypeController` and `MatchState` own the match itself (phases, timers, scoring, teams and the round loop). A gametype never talks to the controller directly. It returns data and reacts to calls, which keeps each mode testable on its own.

Read the smallest examples first: **`Duel.ts`** (a plain timed mode), **`Amphi.ts`** (the smallest round mode, with kits and overtime) and **`SearchAndDestroy.ts`** (a full objective mode).

## The match lifecycle

`MatchState` moves through these phases (`MatchPhase` in the engine's `src/shared/server/gametype/GametypeTypes.ts`):

| Phase | What happens |
|-------|--------------|
| **Warmup** | Players join and free-fight with no scoring. **F4** readies you; the match starts when everyone is ready, or the warmup times out |
| **Countdown** | A short countdown before the match starts. In a round mode this is the **freeze** before each round |
| **Active** | The match is live: scoring, pickups and win conditions apply |
| **RoundEnd** | Round modes only. A round has been decided; nobody moves or shoots while the result banner shows |
| **PostGame** | Result screen, then the match ends. Lobby matches run with `--single-match`, so the server then exits |

## What you must implement

```ts
export class MyMode extends BaseGametype {
  readonly name = "MyMode";
  readonly maxPlayers = 8;
  readonly teamBased = false;

  getMatchConfig(): MatchConfig { ... }
  getSpawnLoadout(playerId?: PlayerId): WeaponLoadout { ... }
  getItemSpawnRules(): ItemSpawnRules { ... }
  getSpawnStrategy(): SpawnStrategyType { ... }  // "random" | "furthest" | "team"

  onPlayerJoin(...) {}
  onSpawn(...) {}
  onDeath(...) {}
  checkWinCondition(...) { return null; }
  getScore(...) { return 0; }
}
```

`checkWinCondition` and `getScore` return nothing useful in the shipped modes: the controller and `MatchState` score kills and decide the winner. Override them only for something the controller can't express.

### `getMatchConfig()`

| Field | Meaning |
|-------|---------|
| `warmupTimeout`, `countdownDuration` | Seconds |
| `scoreLimit`, `timeLimit` | Frags (or rounds, in a round mode) and seconds. `0` disables a limit. In a round mode `timeLimit` is the **round** length |
| `postGameDuration` | Seconds on the result screen |
| `respawnDelay`, `maxRespawnDelay` | Seconds before you may respawn, and when you are respawned automatically |
| `selfDamage` | Multiplier on damage you do to yourself |
| `overtimeOnDraw`, `overtimeDuration` | A tie at the limit extends the match instead of ending it |
| `roundBased`, `roundsPerHalf`, `leadRequired`, `roundEndDuration` | The round loop; `leadRequired: 2` makes 10–9 not a win |
| `roundRespawns`, `resetScoresEachRound`, `maxRounds` | Round variants (Amphi respawns inside a round and plays a fixed number) |
| `roundOvertimeOnDraw`, `roundOvertimeDuration` | A tied round at the timer extends it |
| `teamSpawnProtection` | Seconds a fresh spawn cannot be hurt by its own team |

The environment variables `SHAG_TIMELIMIT`, `SHAG_SCORELIMIT` and `SHAG_WARMUP` override the time, score and warmup limits at boot; see [Server Commands](./server-commands.md#match-pacing-overrides).

### Loadout, items and spawns

- **`getSpawnLoadout()`** returns the weapons, ammo, health and armor a player spawns with. For a mode where the player picks a kit, override `setPlayerLoadout()`, which must take effect from the **next** round, and `hasChosenLoadout()`. Amphi and Search & Destroy both use the shared `LoadoutChoice` (`src/shared/server/gametype/Loadout.ts`).
- **`getItemSpawnRules()`** chooses whether map items spawn, which classnames to leave out (`excludeClassnames`) and when items return (`respawnMode`: `timed`, `round` or `alternating`). The respawn-time fields exist on the type, but the pickup system currently ignores most of them; see [Pickup respawn](../player/pickups-and-inventory.md#pickup-respawn).
- **`getSpawnStrategy()`** picks `random`, `furthest` from other players, or `team` (a team's own spawn points).

## Optional hooks

Override these only when the mode needs them; each has a no-op default.

| Hook | Use |
|------|-----|
| `onMapLoad(context)` | Read authoring from the BSP (bomb sites, flag stands) before the first tick |
| `onRoundStart(state, ctx)` | Round modes: settle sides and loadouts before the world resets and players respawn |
| `onTick(state, ctx)` | Objective logic each tick. Return a `RoundOutcome` to end the round |
| `onRoundTimeExpired(state)` | Decide who wins when the round clock runs out. Returning `null` lets the round continue (Amphi uses it for overtime, Search & Destroy for an armed bomb) |
| `onPickup(player, classname, state)` | Return `false` to deny a pickup |
| `onMatchPhaseChange(phase, state)` | React to phase changes |
| `onPlayerLeave(playerId)` | **Required if you keep per-player state**, or a long-running server leaks a row per player |
| `getAgentDirectives(ctx, state)` | Give bots mode-aware goals as plain data; see Search & Destroy's bomb orders |

## Registering it

A class on its own is not enough. Amphi needed all four of these:

1. Export it from `server/gametypes/index.ts`.
2. Add its keyword to the constructor mapping in `src/cli/headless-netserver-v2.ts` (engine repo), which is what a dedicated server picks from, including any aliases. Unknown keywords **fall through to Deathmatch** rather than failing.
3. Add any alias to `normalizeGametype` in `client/FpsMapLauncher.ts`, which maps what a player types at `map <name> <gametype>` onto the lobby's ids.
4. Add it to `GAMETYPE_SHELLS` in the engine repo's `src/lobby/LobbyServer.ts` with its player count, team flag and team names, or the lobby will never offer it. The lobby only advertises a mode whose maps are installed, so its maps also need entries in `config/maps.json`.

Modes not enabled in step 4 are outside the first release's lobby selection.

If the mode should be ranked, nothing more is needed: ranked rules are decided from the room's roster, not from the gametype (see [Ranked matches](../multiplayer/lobby.md#ranked-matches)).

## Testing

Gametype tests are in `server/gametypes/__tests__/` (`Amphi.test.ts`, `AgentDirectives.test.ts`, `PlayerLifecycle.test.ts`, `RoundLifecycle.test.ts`). Copy their setup: a gametype is built to run without a server, so most rules can be tested by calling its methods.

## Don't forget the manual

Add a page under `docs/manual/gametypes/`, link it from [the overview](../gametypes/index.md) and the sidebar in `docs/manual/.vitepress/config.ts`.
