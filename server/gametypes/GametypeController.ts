/**
 * Gametype Controller
 *
 * Orchestrates the gametype within the server tick loop.
 * Sits between the simulation (125Hz subsystems) and the gametype script.
 *
 * Flow per tick:
 * 1. simulation.tick()          ← physics, combat, weapons
 * 2. gametypeController.postTick()  ← process kills, check win, respawn, match state
 * 3. broadcastSnapshot()        ← send state + events to clients
 */

import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import type { EntityId, PlayerId, TickNumber } from "@engine/server/ecs/types";
import { EntityType } from "@engine/server/ecs/types";
import type {
  AgentDirective,
  AgentDirectiveContext,
  MatchConfig,
  MatchStateSnapshot,
  TeamId,
} from "@shared/server/gametype";
import { emptyPlayerStats, MatchPhase, normalizeTeamId } from "@shared/server/gametype";
import { clearPowerups } from "@shared/server/simulation/components/PowerupComponent";
import type { Vec3 } from "@shared/server/simulation/types";
import { log } from "../../../../engine/core/Log";
import type { BspEntity, BspModel } from "../../../../engine/loader/bsp/BspLoader";
import type { CollisionWorld } from "../../../../engine/network/systems/collision/CollisionWorld";
import { Contents } from "../../../../engine/network/systems/collision/CollisionWorld";
import { rngFrom } from "../../../../shared/DeterministicRng";
import { toClientKey } from "../../ClientEntityKey";
import type { CombatSystem } from "../systems/CombatSystem";
import type { WeaponSystem } from "../systems/WeaponSystem";
import { type AwardEvent, AwardTracker } from "./AwardTracker";
import type { BaseGametype, GametypeTickContext, RoundOutcome } from "./BaseGametype";
import { MatchState } from "./MatchState";
import { createSpawnStrategy, type SpawnPointStrategy, TeamSpawnStrategy } from "./SpawnPointStrategy";

// ============================================================================
// Respawn Queue Entry
// ============================================================================

interface RespawnEntry {
  entityId: EntityId;
  /** Earliest tick the player CAN respawn (input-gated) */
  minRespawnTick: number;
  /** Tick at which player is auto-respawned (deadline) */
  maxRespawnTick: number;
}

// ============================================================================
// Controller
// ============================================================================

export class GametypeController {
  private gametype: BaseGametype;
  /** Match config with dev env overrides applied — use this, not gametype.getMatchConfig(). */
  private matchConfig: MatchConfig;
  private matchState: MatchState;
  private spawnStrategy: SpawnPointStrategy;
  private spawnPoints: Vec3[] = [];
  private teamSpawnPoints: ReadonlyMap<string, Vec3[]> = new Map();
  /** Tick each entity last spawned, for spawn protection. */
  private spawnTick = new Map<EntityId, number>();
  /**
   * Latest world, for the damage filter.
   *
   * The filter runs inside the simulation tick, before `postTick`, so it cannot
   * be handed a state — this is the only way it can resolve who is on whose
   * team without CombatSystem growing a dependency on the match.
   */
  private lastState: WorldState | null = null;
  private respawnQueue: RespawnEntry[] = [];
  private collisionWorld: CollisionWorld | null = null;
  /** Latest sim tick (from postTick) — seeds deterministic spawn selection for
   *  join-time spawns, which happen outside the tick loop (R3b / demo re-sim). */
  private currentTick = 0;
  private matchStartReset: ((state: WorldState, tickNum: number) => void) | null = null;
  private botPlayerIds: Set<PlayerId> = new Set();

  private combatSystem: CombatSystem | null = null;
  private weaponSystem: WeaponSystem | null = null;
  private awardTracker = new AwardTracker();
  /** Resolves PlayerId → display name (set by GameServer) */
  private nameResolver: ((playerId: PlayerId) => string) | null = null;

  constructor(gametype: BaseGametype) {
    this.gametype = gametype;
    this.matchConfig = GametypeController.applyEnvOverrides(gametype.getMatchConfig());
    this.matchState = new MatchState(gametype.name, this.matchConfig, gametype.teamBased);
    this.spawnStrategy = createSpawnStrategy(gametype.getSpawnStrategy());

    // A mode that derives score from stats installs its formula once; the
    // default returns null and MatchState keeps counting frags.
    if (gametype.scoreFromStats(emptyPlayerStats()) !== null) {
      this.matchState.setScoreFormula((stats) => gametype.scoreFromStats(stats) ?? 0);
      console.log(`[GametypeController] Score derived from stats`);
    }

    console.log(`[GametypeController] Initialized: ${gametype.name}`);
    console.log(`[GametypeController] Spawn strategy: ${gametype.getSpawnStrategy()}`);
    console.log(
      `[GametypeController] Score limit: ${this.matchConfig.scoreLimit}, Time limit: ${this.matchConfig.timeLimit}s`,
    );
  }

  /**
   * Dev/test overrides for match pacing via environment variables:
   *   SHAG_TIMELIMIT — match time limit. Bare number = MINUTES (Quake
   *     g_timelimit semantics): "2" = 2 minutes. Suffix for seconds: "90s".
   *   SHAG_WARMUP    — warmup timeout. Bare number = SECONDS: "10" = 10s.
   *     Suffix for minutes: "2m".
   *   SHAG_SCORELIMIT — frag/score limit (plain number).
   * Read once at server boot; inert when unset. Lobby-spawned servers inherit
   * the lobby process env, so one export covers the whole dev session.
   */
  private static applyEnvOverrides(config: MatchConfig): MatchConfig {
    const env = typeof process !== "undefined" ? process.env : undefined;
    if (!env) return config;

    /** Parse a time value to seconds. `defaultUnit` applies to bare numbers. */
    const parseTime = (raw: string, defaultUnit: "s" | "m"): number | null => {
      const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|s|sec)?$/i);
      if (!m) return null;
      const value = Number(m[1]);
      if (!Number.isFinite(value) || value < 0) return null;
      const unit = (m[2] ?? defaultUnit).toLowerCase();
      return unit.startsWith("m") ? value * 60 : value;
    };

    const overridden = { ...config };
    const apply = (
      key: string,
      field: "timeLimit" | "scoreLimit" | "warmupTimeout",
      timeDefaultUnit: "s" | "m" | null,
    ) => {
      const raw = env[key];
      if (raw === undefined || raw === "") return;
      const value = timeDefaultUnit ? parseTime(raw, timeDefaultUnit) : Number(raw);
      if (value === null || !Number.isFinite(value) || value < 0) {
        console.warn(`[GametypeController] Ignoring invalid ${key}="${raw}"`);
        return;
      }
      overridden[field] = value;
      const unitNote = timeDefaultUnit ? `${value}s` : `${value}`;
      console.log(`[GametypeController] Env override: ${field} = ${unitNote} (${key}="${raw}")`);
    };
    apply("SHAG_TIMELIMIT", "timeLimit", "m"); // bare = minutes, like g_timelimit
    apply("SHAG_SCORELIMIT", "scoreLimit", null);
    apply("SHAG_WARMUP", "warmupTimeout", "s"); // bare = seconds, like g_warmup
    return overridden;
  }

  // ========================================================================
  // Setup
  // ========================================================================

  /**
   * Set subsystem references for interaction.
   * Called after all subsystems are created.
   */
  setSubsystems(combat: CombatSystem, weapon: WeaponSystem): void {
    this.combatSystem = combat;
    this.weaponSystem = weapon;

    const protection = this.matchConfig.teamSpawnProtection ?? 0;
    if (protection > 0 && this.gametype.teamBased) {
      const windowTicks = Math.floor(protection * 125);
      combat.setDamageFilter((event, tick) => this.allowDamage(event, tick, windowTicks));
      console.log(`[GametypeController] Team spawn protection: ${protection}s`);
    }
  }

  /**
   * Should this hit land?
   *
   * Only one rule today: a freshly spawned player cannot be hurt by their own
   * side. Friendly fire is otherwise on, and enemy damage is never blocked —
   * spawn protection here is against your teammates' rockets, not against the
   * other team, who cannot reach you at a team spawn anyway.
   */
  private allowDamage(
    event: { victimId: EntityId; attackerId?: EntityId },
    tick: number,
    windowTicks: number,
  ): boolean {
    if (event.attackerId === undefined || event.attackerId === event.victimId) return true;

    const spawnedAt = this.spawnTick.get(event.victimId);
    if (spawnedAt === undefined || tick - spawnedAt > windowTicks) return true;

    const state = this.lastState;
    if (!state) return true;
    const attacker = state.getEntity(event.attackerId);
    const victim = state.getEntity(event.victimId);
    if (attacker?.ownerId === undefined || victim?.ownerId === undefined) return true;

    const attackerTeam = this.matchState.getPlayerTeam(attacker.ownerId);
    return attackerTeam === "spectator" || attackerTeam !== this.matchState.getPlayerTeam(victim.ownerId);
  }

  /**
   * Install the server-owned world reset run atomically before match-start
   * respawns. GametypeController owns the phase edge; GameServer owns systems.
   */
  setMatchStartReset(reset: (state: WorldState, tickNum: number) => void): void {
    this.matchStartReset = reset;
  }

  /**
   * Set name resolver for player display names.
   * Called by GameServer after construction.
   */
  setNameResolver(resolver: (playerId: PlayerId) => string): void {
    this.nameResolver = resolver;
  }

  /**
   * Set the match flow mode (from GameServerConfig.singleMatch, at boot).
   * "single" makes PostGame terminal — see docs/research/single_game_server_lobby.md.
   */
  setMatchFlow(flow: "single" | "continuous"): void {
    this.matchState.setFlow(flow);
    // A single-match server was spawned by the lobby for a queued group, so
    // humans are on their way even though none have connected yet. That is the
    // only advance notice the server gets, and without it bots — which ready
    // instantly — start the match before anyone's map has finished loading.
    this.matchState.setExpectsHumans(flow === "single");
  }

  /**
   * Get the award tracker (for gametype scripts to emit custom awards).
   */
  getAwardTracker(): AwardTracker {
    return this.awardTracker;
  }

  /**
   * Drain pending awards (called by SnapshotBuilder).
   */
  drainAwards(): AwardEvent[] {
    return this.awardTracker.drainAwards();
  }

  /**
   * Set available spawn points (from BSP parsing).
   */
  setSpawnPoints(points: Vec3[], teamPoints?: ReadonlyMap<string, Vec3[]>): void {
    this.spawnPoints = points;
    if (teamPoints) this.teamSpawnPoints = teamPoints;

    // Feed team-tagged points to the strategy when the map has them. Only
    // TeamSpawnStrategy consumes these; other strategies ignore the call, so
    // this is safe to do unconditionally.
    if (teamPoints && this.spawnStrategy instanceof TeamSpawnStrategy) {
      for (const [team, teamSpawns] of teamPoints) {
        this.spawnStrategy.setTeamPoints(team, teamSpawns);
      }
      const summary = [...teamPoints].map(([t, p]) => `${t}=${p.length}`).join(", ");
      console.log(`[GametypeController] Team spawn points: ${summary || "none"}`);
    }
    console.log(`[GametypeController] ${points.length} spawn points loaded`);
  }

  /**
   * Set collision world for spawn validation.
   * Enables jitter to trace-check candidate positions against BSP geometry.
   */
  setCollisionWorld(world: CollisionWorld): void {
    this.collisionWorld = world;
    console.log(`[GametypeController] Collision world set for spawn validation`);
  }

  /**
   * Hand the loaded map to the gametype.
   *
   * Call after `setSpawnPoints` and `setCollisionWorld` and before the first
   * tick — the mode gets one look at the map and is expected to extract and
   * cache whatever it needs. Modes that need nothing pay a single no-op call.
   */
  setMapData(entities: readonly BspEntity[], models: readonly BspModel[] = []): void {
    try {
      this.gametype.onMapLoad({
        entities,
        models,
        teamSpawnPoints: this.teamSpawnPoints,
        collision: this.collisionWorld,
      });
    } catch (err) {
      // A mode that cannot read the map should degrade, not take the server
      // down at boot — it will fail visibly in play instead.
      log.warnRateLimited("GametypeController", "onMapLoad threw:", err);
    }
  }

  // ========================================================================
  // Player Lifecycle
  // ========================================================================

  /**
   * Handle a new player joining.
   * Returns a spawn position for the player entity.
   */
  onPlayerJoin(
    playerId: PlayerId,
    entityId: EntityId,
    state: WorldState,
    teamId?: string,
    playerName?: string,
  ): Vec3 | null {
    // Track in match state
    this.matchState.addPlayer(playerId);

    // Auto-balance teams if team-based
    if (this.gametype.teamBased) {
      // For Duel, rename the team to the player's name
      if (this.gametype.name === "Duel") {
        const assignedPlayerName = playerName || `Player ${playerId}`;
        let assignedTeam = teamId as any;

        // If they didn't pick a team, or if they picked a team but Duel is full
        if (!assignedTeam || assignedTeam !== "spectator") {
          // Let assignTeamBalance handle spectator forcing if full
          assignedTeam = this.matchState.assignTeamBalance(playerId, this.gametype.name);
        } else {
          this.matchState.setPlayerTeam(playerId, assignedTeam);
        }

        if (assignedTeam !== "spectator") {
          this.matchState.setTeamName(assignedTeam, assignedPlayerName);
        }
      } else {
        // A side chosen in the lobby arrives as `alpha`/`bravo`; the match
        // speaks `udon`/`soba`. Nothing translated, so the request was silently
        // dropped and every player got auto-balanced instead.
        const requested = normalizeTeamId(teamId);
        if (requested && requested !== "spectator") {
          // Asking for a side is a preference, not an instruction — taking it
          // literally is how a 2v2 lobby became a 3v1 match.
          this.matchState.assignTeamRespectingBalance(playerId, requested, this.gametype.name);
        } else {
          this.matchState.assignTeamBalance(playerId, this.gametype.name);
        }
      }
    }

    // For team-based gametypes, spectators don't get spawned
    // For FFA/DM, skip this check — all players spawn
    const finalTeamId = this.gametype.teamBased ? this.matchState.getPlayerTeam(playerId) : teamId;
    if (this.gametype.teamBased) {
      if (finalTeamId === "spectator") {
        this.matchState.spectatePlayer(playerId);
        console.log(
          `[GametypeController] Player ${playerId} observing as spectator (${this.matchState.totalPlayers} total)`,
        );
        return null;
      }
    }

    // Delegate to gametype for specific logic (e.g. initial loadout)
    this.gametype.onPlayerJoin(playerId, String(entityId), state, finalTeamId);

    // Choose spawn point
    console.log(
      `[GametypeController] Choosing from ${this.spawnPoints.length} spawn points, collision=${!!this.collisionWorld}`,
    );
    // Seeded from (lastTick, entity) so spawn selection is deterministic for demo
    // re-sim (R3b). Join happens outside the tick loop, so use the latest tick.
    const spawnRng = rngFrom(this.currentTick, entityId as number, 0);
    const baseSpawn = this.spawnStrategy.choose(
      this.spawnPoints,
      state,
      entityId,
      spawnRng,
      this.spawnSetFor(finalTeamId),
    );
    console.log(
      `[GametypeController] Base spawn: (${baseSpawn.x.toFixed(0)}, ${baseSpawn.y.toFixed(0)}, ${baseSpawn.z.toFixed(0)})`,
    );
    const spawn = this.jitterSpawn(baseSpawn, spawnRng);

    // Apply weapon loadout
    if (this.weaponSystem) {
      const loadout = this.gametype.getSpawnLoadout(playerId);
      this.weaponSystem.initializeWeaponFromLoadout(entityId, loadout);
    }

    console.log(`[GametypeController] Player ${playerId} joined (${this.matchState.totalPlayers} total)`);
    return spawn;
  }

  /** Move a connected player to spectators without ending their session. */
  onPlayerSpectate(playerId: PlayerId, entityId?: EntityId): void {
    this.matchState.spectatePlayer(playerId);
    if (entityId !== undefined) this.spawnTick.delete(entityId);
    console.log(`[GametypeController] Player ${playerId} is spectating (${this.matchState.totalPlayers} total)`);
  }

  /** Handle player disconnect. */
  onPlayerDisconnect(playerId: PlayerId, entityId?: EntityId): void {
    this.botPlayerIds.delete(playerId);
    this.matchState.setBotPlayers(this.botPlayerIds);
    this.matchState.removePlayer(playerId);
    if (entityId !== undefined) this.spawnTick.delete(entityId);
    try {
      this.gametype.onPlayerLeave(playerId);
    } catch (err) {
      log.warnRateLimited("GametypeController", "onPlayerLeave threw:", err);
    }
    console.log(`[GametypeController] Player ${playerId} disconnected (${this.matchState.totalPlayers} total)`);
  }

  /**
   * Handle player ready (F4 press).
   * When a human player readies, all bots auto-ready after a random 0-5s delay.
   */
  onPlayerReady(playerId: PlayerId): void {
    this.matchState.playerReady(playerId);

    // If a human player readied, schedule all bots to ready up too
    if (!this.botPlayerIds.has(playerId)) {
      for (const botId of this.botPlayerIds) {
        const delay = Math.random() * 5000; // 0-5 seconds
        setTimeout(() => {
          this.matchState.playerReady(botId);
        }, delay);
      }
    }
  }

  /**
   * True when a player joining right now must sit the round out.
   *
   * In a round mode there is no respawn, so a player who spawns mid-round has
   * appeared from nowhere into a fight the others have been having since the
   * freeze — and, because spawn points belong to a side, quite possibly inside
   * the enemy's half. They wait for the next freeze, which is exactly what
   * dying already does.
   */
  get joinMustWaitForNextRound(): boolean {
    return (
      this.matchState.roundBased &&
      (this.matchState.phase === MatchPhase.Active || this.matchState.phase === MatchPhase.RoundEnd)
    );
  }

  /**
   * Register a bot player ID for auto-ready tracking.
   * Note: onPlayerJoin() must be called first to add bot to match state.
   *
   * Bots ready up IMMEDIATELY on join — a bot never has a reason to stay
   * unready, and without this a bot invited after the human pressed F4 left
   * warmup waiting out its full timeout (match then started silently, warmup
   * frags didn't count, and the result read as a baffling 0-0 draw).
   */
  registerBot(playerId: PlayerId): void {
    this.botPlayerIds.add(playerId);
    this.matchState.setBotPlayers(this.botPlayerIds);
    this.matchState.playerReady(playerId);
  }

  /**
   * How many human clients are connected, spectators included.
   *
   * The ready gate needs it: bots ready on join, so without knowing a human is
   * present the match starts among the bots while that human is still loading.
   */
  setHumanClientCount(count: number): void {
    this.matchState.setHumanClients(count);
  }

  // ========================================================================
  // Post-Tick Processing
  // ========================================================================

  /**
   * Called after simulation.tick() each frame.
   * Processes events, updates match state, handles respawns.
   */
  postTick(state: WorldState, dt: number, tick: TickNumber): void {
    const tickNum = tick as number;
    this.currentTick = tickNum;
    this.lastState = state;

    // 1. Process kills from CombatSystem
    if (this.combatSystem) {
      const kills = this.combatSystem.getRecentKills();
      for (const kill of kills) {
        // Get entities for gametype event
        const victim = state.getEntity(kill.victimId);
        const killer = kill.killerId ? state.getEntity(kill.killerId) : null;

        if (victim) {
          // Tell gametype about the kill
          this.gametype.onDeath(victim as Entity, killer as Entity | null, state);

          // Update score (only during Active phase)
          if (this.matchState.phase === MatchPhase.Active) {
            if (killer?.ownerId && killer.ownerId !== victim.ownerId) {
              if (this.gametype.teamBased) {
                const killerTeam = this.matchState.getPlayerTeam(killer.ownerId);
                const victimTeam = victim.ownerId ? this.matchState.getPlayerTeam(victim.ownerId) : "spectator";
                // In a round mode the team score IS the round count, so frags
                // must not touch it — only endRound() may. Personal score still
                // counts frags for the scoreboard.
                const teamPoints = this.matchState.roundBased ? 0 : 1;

                if (killerTeam === victimTeam) {
                  // Friendly fire / Team kill
                  this.matchState.recordStat(killer.ownerId, (s) => {
                    s.teamFrags++;
                  });
                  this.matchState.addScore(killer.ownerId, -1);
                  this.matchState.addTeamScore(killerTeam, -teamPoints);
                } else if (killerTeam !== "spectator") {
                  // Enemy kill
                  this.matchState.recordStat(killer.ownerId, (s) => {
                    s.frags++;
                  });
                  this.matchState.addScore(killer.ownerId, 1);
                  this.matchState.addTeamScore(killerTeam, teamPoints);
                }
              } else {
                // FFA: any kill is +1
                this.matchState.recordStat(killer.ownerId, (s) => {
                  s.frags++;
                });
                this.matchState.addScore(killer.ownerId, 1);
              }
            } else if (killer?.ownerId === victim.ownerId) {
              // Suicide
              if (victim.ownerId !== undefined) {
                this.matchState.addScore(victim.ownerId, -1);
                if (this.gametype.teamBased && !this.matchState.roundBased) {
                  const victimTeam = this.matchState.getPlayerTeam(victim.ownerId);
                  if (victimTeam !== "spectator") {
                    this.matchState.addTeamScore(victimTeam, -1);
                  }
                }
              }
            }

            // Track deaths (score only)
            if (victim.ownerId !== undefined) {
              this.matchState.addDeath(victim.ownerId);
              this.matchState.recordStat(victim.ownerId, (s) => {
                s.deaths++;
              });
            }
          }

          // Track awards (frag notifications, streaks — always, including warmup)
          if (victim.ownerId !== undefined) {
            this.awardTracker.onDeath(victim.ownerId);
          }
          if (killer?.ownerId && killer.ownerId !== victim.ownerId) {
            const killerName = this.resolvePlayerName(killer.ownerId);
            const victimName = victim.ownerId !== undefined ? this.resolvePlayerName(victim.ownerId) : "unknown";
            this.awardTracker.onKill(killer.ownerId, victim.ownerId ?? (0 as PlayerId), killerName, victimName);
          }

          // Queue respawn with min/max timers (Warsow-style)
          const config = this.matchConfig;
          const minDelay = Math.floor(config.respawnDelay * 125);
          const maxDelay = Math.floor((config.maxRespawnDelay ?? config.respawnDelay * 2) * 125);

          // Drop all weapons on death
          if (this.weaponSystem) {
            this.weaponSystem.dropAllWeapons(kill.victimId);
          }

          this.respawnQueue.push({
            entityId: kill.victimId,
            minRespawnTick: tickNum + minDelay,
            maxRespawnTick: tickNum + maxDelay,
          });
        }
      }
      this.combatSystem.clearKills();
      this.recordDamageDealt(state);
    }

    // 2. Process respawn queue
    this.processRespawns(state, tickNum);

    // 3. Update match state
    const phaseChanged = this.matchState.update(dt);
    if (phaseChanged) {
      this.gametype.onMatchPhaseChange(this.matchState.phase, state);

      // Round modes reset at the FREEZE, not at the go. Every item returns to
      // the map, dropped weapons and live projectiles are cleared, and everyone
      // respawns — so the freeze is spent standing at your own spawn reading
      // the map, which is the whole point of having one. `applyPostGameInputFreeze`
      // holds them still until the round goes live.
      if (this.matchState.roundBased && this.matchState.phase === MatchPhase.Countdown) {
        // Before the respawns, so the mode's decisions are already true when
        // players appear — respawning applies each player's chosen loadout.
        try {
          this.gametype.onRoundStart(state, this.tickContext(tick));
        } catch (err) {
          log.warnRateLimited("GametypeController", "onRoundStart threw:", err);
        }
        this.matchStartReset?.(state, tickNum);
        this.respawnAllPlayers(state, tickNum);
      }

      // On match start (countdown → active), respawn all players
      if (this.matchState.phase === MatchPhase.Active) {
        if (!this.matchState.roundBased) {
          this.matchStartReset?.(state, tickNum);
          this.respawnAllPlayers(state, tickNum);
        }
        this.awardTracker.onMatchStart();
      }

      // Match ended on the time limit — record who won for the post-game screen.
      if (this.matchState.phase === MatchPhase.PostGame) {
        this.recordMatchWinner();
      }

      // New warmup (post-game rollover): transition cleared the ready set, so
      // re-ready the bots — otherwise match #2 waits out the whole warmup.
      if (this.matchState.phase === MatchPhase.Warmup) {
        for (const botId of this.botPlayerIds) {
          this.matchState.playerReady(botId);
        }
      }
    }

    // 3a. Objective tick. Runs in every phase — a bomb still has to be put back
    // on the ground during the freeze — but it can only END a round while one
    // is live, which the `live` flag tells it.
    const outcome = this.tickGametype(state, tick);
    if (outcome) {
      console.log(`[GametypeController] Round ${this.matchState.round}: ${outcome.reason}`);
      this.endRound(outcome.winner, outcome);
    }

    // 3b. Round modes: an expired round timer ends the ROUND, and the gametype
    // decides who won it. MatchState deliberately does not make that call.
    // A null result means the mode declined to end the round — S&D does that
    // for an armed bomb, where the bomb's timer supersedes the round's. The
    // expiry flag stays set, so this is re-asked each tick until something
    // resolves it.
    if (this.matchState.roundBased && this.matchState.roundTimeExpired) {
      let expiry: RoundOutcome | null = null;
      try {
        expiry = this.gametype.onRoundTimeExpired(state);
      } catch (err) {
        log.warnRateLimited("GametypeController", "onRoundTimeExpired threw:", err);
      }
      if (expiry) {
        console.log(`[GametypeController] Round ${this.matchState.round}: ${expiry.reason}`);
        this.endRound(expiry.winner, expiry);
      }
    }

    // 4. Check win condition during active phase
    if (this.matchState.phase === MatchPhase.Active) {
      const config = this.matchConfig;
      // Round modes reach the limit through endRound(), which applies the lead
      // requirement (tennis rule) — the plain >= check below would end a match
      // at 10-9 that should still be running.
      if (this.matchState.roundBased) {
        // handled in endRound()
      } else if (config.scoreLimit > 0) {
        let limitReached = false;

        if (this.gametype.teamBased) {
          for (const [_teamId, score] of this.matchState.teamScores) {
            if (score >= config.scoreLimit) {
              limitReached = true;
              break;
            }
          }
        } else {
          for (const [_playerId, score] of this.matchState.scores) {
            if (score >= config.scoreLimit) {
              limitReached = true;
              break;
            }
          }
        }

        if (limitReached) {
          console.log(`[GametypeController] Score limit reached!`);
          this.matchState.endMatch();
          // Score-limit path enters PostGame outside matchState.update(), so the
          // phaseChanged block above didn't see it — record the winner here.
          this.recordMatchWinner();
        }
      }
    }
  }

  // ========================================================================
  // Respawn Logic
  // ========================================================================

  private processRespawns(state: WorldState, tickNum: number): void {
    // Round modes have no in-round respawn: the dead stay dead until the next
    // round's freeze, where respawnAllPlayers() puts everyone back. Draining
    // the queue here would undo the entire premise of the mode — and during the
    // intermission it would also have players popping back up mid-explosion.
    if (
      this.matchState.roundBased &&
      (this.matchState.phase === MatchPhase.Active || this.matchState.phase === MatchPhase.RoundEnd)
    ) {
      return;
    }

    const remaining: RespawnEntry[] = [];

    for (const entry of this.respawnQueue) {
      if (tickNum >= entry.maxRespawnTick) {
        // Auto-respawn deadline reached
        this.respawnPlayer(state, entry.entityId, tickNum);
      } else if (tickNum >= entry.minRespawnTick) {
        // Input-gated window: respawn if player sent RequestSpawn message
        const entity = state.getEntityMut(entry.entityId);
        if (!entity?.input) {
          remaining.push(entry);
          continue;
        }

        if (entity.input.wantsRespawn) {
          this.respawnPlayer(state, entry.entityId, tickNum);
        } else {
          remaining.push(entry);
        }
      } else {
        remaining.push(entry);
      }
    }

    this.respawnQueue = remaining;
  }

  private respawnPlayer(state: WorldState, entityId: EntityId, tickNum: number): void {
    const entity = state.getEntityMut(entityId);
    if (!entity) return;

    this.spawnTick.set(entityId, tickNum);

    // Choose spawn point using strategy — seeded for deterministic re-sim (R3b).
    const spawnRng = rngFrom(tickNum, entityId as number, 0);
    // Team modes spawn a player among their OWN side's points.
    const spawnTeam = entity.ownerId !== undefined ? this.matchState.getPlayerTeam(entity.ownerId) : undefined;
    const baseSpawn = this.spawnStrategy.choose(
      this.spawnPoints,
      state,
      entityId,
      spawnRng,
      this.spawnSetFor(spawnTeam),
    );
    const spawn = this.jitterSpawn(baseSpawn, spawnRng);

    // Get loadout from gametype — per-player, since S&D lets players choose.
    const loadout = this.gametype.getSpawnLoadout(entity.ownerId);

    // Reset health/armor
    if (entity.health) {
      entity.health.health = loadout.health;
      entity.health.armor = loadout.armor;
      entity.health.dead = false;
    }

    // Powerups do NOT survive dying — killing the quad carrier has to actually
    // take the quad away, or there is no reason to contest it.
    if (entity.powerups) clearPowerups(entity.powerups);

    // Set position
    if (entity.transform) {
      entity.transform.position = { ...spawn };
    }

    // Reset velocity
    if (entity.physics) {
      entity.physics.velocity = { x: 0, y: 0, z: 0 };
      entity.physics.angularVelocity = { x: 0, y: 0, z: 0 };
      entity.physics.grounded = false;
      entity.physics.jumping = false;
      entity.physics.isSliding = false;
      entity.physics.isCrouching = false;
      entity.physics.crouchViewOffset = 0;
      entity.physics.wallJumpState = "none";
      entity.physics.ledgeGrabState = "none";
      entity.physics.actualHorizSpeed = 0;
    }

    // Spawn protection: freeze physics for a few ticks to prevent
    // falling through the world before collision is ready
    entity.spawnTick = tickNum;

    // Reset weapon loadout
    if (this.weaponSystem) {
      this.weaponSystem.initializeWeaponFromLoadout(entityId, loadout);
    }

    // Tell gametype
    this.gametype.onSpawn(entity, state);

    // Clear respawn request flag
    if (entity.input) {
      entity.input.forward = 0;
      entity.input.right = 0;
      entity.input.buttons = 0;
      entity.input.jump = false;
      entity.input.crouch = false;
      entity.input.attack = false;
      entity.input.altAttack = false;
      entity.input.use = false;
      entity.input.weaponSlot = 1;
      entity.input.inputQueue = [];
      entity.input.wantsRespawn = false;
    }

    console.log(
      `[GametypeController] Respawned entity ${entityId} at (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)}, ${spawn.z.toFixed(0)})`,
    );
  }

  private respawnAllPlayers(state: WorldState, tickNum: number): void {
    console.log(`[GametypeController] Match start — respawning all players`);
    for (const entity of state.players()) {
      this.respawnPlayer(state, entity.id, tickNum);
    }
    // Clear any pending respawns
    this.respawnQueue = [];
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private resolvePlayerName(playerId: PlayerId): string {
    return this.nameResolver?.(playerId) ?? `Player ${playerId}`;
  }

  /** Compute + store the match result (for the post-game screen banner). */
  private recordMatchWinner(): void {
    const winner = this.matchState.computeWinner(this.gametype.teamBased, (pid) => this.resolvePlayerName(pid));
    console.log(`[GametypeController] Match result: ${winner.kind}${winner.name ? ` — ${winner.name}` : ""}`);
  }

  /**
   * Freeze gameplay input while the post-game screen is up: zero movement and
   * action buttons on every player entity (current state AND queued usercmds)
   * but keep view angles + sequence numbers, so players can still look around
   * and client reconciliation acks stay intact. Called by GameServer each tick
   * BEFORE simulation.tick(). Deterministic — driven only by match phase.
   */
  applyPostGameInputFreeze(state: WorldState): void {
    // Also covers the round freeze: in a round mode `Countdown` is the freeze
    // phase, where players are spawned and held until the round goes live.
    // The round-end intermission freezes too: the round is decided, and a
    // player still shooting during the result screen is scoring nothing and
    // distracting from the thing they are meant to be watching.
    const freezing =
      this.matchState.phase === MatchPhase.PostGame ||
      this.matchState.phase === MatchPhase.RoundEnd ||
      (this.matchState.roundBased && this.matchState.phase === MatchPhase.Countdown);
    if (!freezing) return;

    for (const entity of state.allEntities()) {
      if (entity.ownerId === undefined || !entity.input) continue;
      const input = entity.input;
      input.forward = 0;
      input.right = 0;
      input.buttons = 0;
      input.jump = false;
      input.crouch = false;
      input.attack = false;
      input.altAttack = false;
      input.use = false;
      for (const queued of input.inputQueue) {
        queued.forward = 0;
        queued.right = 0;
        queued.buttons = 0;
        queued.weaponSlot = 0; // 0 = no weapon change
      }
    }
  }

  // ========================================================================
  // Queries
  // ========================================================================

  /**
   * Ask the gametype for each living player's orders.
   *
   * Called once per snapshot (not per tick) from snapshot building. Returns an
   * empty map for gametypes that issue none, which is every mode today — the
   * default `getAgentDirectives` returns `[]`, so this costs one virtual call
   * per player and allocates nothing until a mode opts in.
   *
   * Keyed by client entity id because that is what the snapshot addresses.
   */
  collectAgentDirectives(state: WorldState, tick: number): Map<string, AgentDirective[]> {
    const byEntity = new Map<string, AgentDirective[]>();

    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (entity.ownerId === undefined) continue;

      const entityId = toClientKey(entity.id);
      const context: AgentDirectiveContext = {
        tick,
        playerId: entity.ownerId as number,
        entityId,
        teamId: this.matchState.getPlayerTeam(entity.ownerId),
        position: entity.transform?.position ?? { x: 0, y: 0, z: 0 },
        alive: !entity.health?.dead,
        teamOf: (id: number) => this.matchState.getPlayerTeam(id as PlayerId),
      };

      // A misbehaving gametype must not take the server down mid-snapshot.
      let directives: readonly AgentDirective[];
      try {
        directives = this.gametype.getAgentDirectives(context, state);
      } catch (err) {
        log.warnRateLimited("GametypeController", "getAgentDirectives threw:", err);
        continue;
      }

      if (directives.length > 0) byEntity.set(entityId, [...directives]);
    }

    return byEntity;
  }

  /**
   * Credit damage dealt, for modes that score on it.
   *
   * Drains scoring's OWN buffer, not the one snapshot building uses. Scoring
   * runs every tick and snapshots are built at a fraction of that, so reading
   * the shared buffer credited each hit once per tick until the next snapshot
   * cleared it — about six times over, and without end on a server with no
   * clients, where snapshots are never built at all.
   *
   * Self-damage is skipped entirely — a rocket jump is a movement technique,
   * not a contribution, and it must not be a way to farm score.
   */
  private recordDamageDealt(state: WorldState): void {
    if (!this.combatSystem) return;
    for (const hit of this.combatSystem.drainDamageForStats()) {
      if (hit.attackerId === undefined || hit.attackerId === hit.victimId) continue;

      const attacker = state.getEntity(hit.attackerId);
      const victim = state.getEntity(hit.victimId);
      if (attacker?.ownerId === undefined || victim?.ownerId === undefined) continue;

      const friendly =
        this.gametype.teamBased &&
        this.matchState.getPlayerTeam(attacker.ownerId) === this.matchState.getPlayerTeam(victim.ownerId);

      this.matchState.recordStat(attacker.ownerId, (s) => {
        if (friendly) s.teamDamageGiven += hit.damage;
        else s.damageGiven += hit.damage;
      });
    }
  }

  /**
   * Credit an objective a player completed — an arm, a defuse.
   *
   * Called by the gametype through the controller rather than written to
   * MatchState directly, so a mode still holds no reference to the match.
   */
  recordObjective(playerId: PlayerId, kind: "plant" | "defuse"): void {
    this.matchState.recordStat(playerId, (s) => {
      if (kind === "plant") s.plants++;
      else s.defuses++;
    });
  }

  /**
   * The spawn SET a team uses, which is not always its own — see
   * `BaseGametype.resolveSpawnTeam`.
   */
  private spawnSetFor(teamId: string | undefined): string | undefined {
    if (teamId === undefined) return undefined;
    try {
      return this.gametype.resolveSpawnTeam(teamId);
    } catch (err) {
      log.warnRateLimited("GametypeController", "resolveSpawnTeam threw:", err);
      return teamId;
    }
  }

  /** The match, as a gametype needs to see it. */
  private tickContext(tick: TickNumber): GametypeTickContext {
    return {
      tick,
      round: this.matchState.round,
      live: this.matchState.phase === MatchPhase.Active,
      attackingTeam: this.matchState.attackingTeam,
      defendingTeam: this.matchState.defendingTeam,
      teamOf: (playerId: PlayerId) => this.matchState.getPlayerTeam(playerId),
      credit: (playerId: PlayerId, kind: "plant" | "defuse") => this.recordObjective(playerId, kind),
    };
  }

  /**
   * Run the gametype's objective tick and hand back any round result.
   *
   * Wrapped because a throwing mode must not take the tick loop down: a bomb
   * that stops updating is a broken round, a crashed server is a broken match.
   */
  private tickGametype(state: WorldState, tick: TickNumber): RoundOutcome | null {
    const context = this.tickContext(tick);

    try {
      const outcome = this.gametype.onTick(state, context);
      // Only a live round can end. A mode returning an outcome during the
      // freeze would otherwise skip a round entirely.
      return outcome && context.live ? outcome : null;
    } catch (err) {
      log.warnRateLimited("GametypeController", "onTick threw:", err);
      return null;
    }
  }

  /**
   * End the current round with the given winner.
   *
   * Called by the controller on a timer expiry, and by the gametype for round
   * ends that are not timer expiries — a defuse, a detonation, or one side
   * being eliminated. Records the match winner when this round decides it.
   */
  endRound(winner: TeamId | null, outcome?: RoundOutcome): void {
    if (!this.matchState.roundBased) return;
    const before = this.matchState.phase;
    this.matchState.endRound(winner, { reason: outcome?.resultKey ?? "eliminated", focus: outcome?.focus });
    if (before !== MatchPhase.PostGame && this.matchState.phase === MatchPhase.PostGame) {
      this.recordMatchWinner();
    }
  }

  getMatchState(): MatchState {
    return this.matchState;
  }

  getMatchSnapshot(): MatchStateSnapshot {
    const snapshot = this.matchState.toSnapshot();
    const roundResult = this.matchState.roundResult;
    if (roundResult) snapshot.roundResult = roundResult;
    // The mode owns its objective; MatchState owns the match. Merged here so
    // there is one shape on the wire rather than two events to correlate.
    const objective = this.gametype.getObjectiveState();
    if (objective) snapshot.objective = objective;
    const roundState = this.gametype.getRoundState();
    if (roundState) snapshot.roundState = roundState;
    const explosion = this.gametype.getExplosion();
    if (explosion) snapshot.explosion = explosion;
    return snapshot;
  }

  getGametype(): BaseGametype {
    return this.gametype;
  }

  getPhase(): MatchPhase {
    return this.matchState.phase;
  }

  getSpawnPoint(state: WorldState, entityId?: EntityId, teamId?: string): Vec3 {
    const spawnRng = rngFrom(this.currentTick, (entityId ?? 0) as number, 0);
    const base = this.spawnStrategy.choose(this.spawnPoints, state, entityId, spawnRng, this.spawnSetFor(teamId));
    return this.jitterSpawn(base, spawnRng);
  }

  // ========================================================================
  // Spawn Jitter — Collision-Validated Position Randomization
  // ========================================================================

  /** Player collision bounds (ORIGIN at waist, -24 feet, +32 head) */
  private static readonly PLAYER_BOUNDS = {
    min: { x: -16, y: -24, z: -16 },
    max: { x: 16, y: 32, z: 16 },
  };

  /** Candidate offsets: 8 compass points around spawn + center */
  private static readonly JITTER_OFFSETS: Vec3[] = [
    { x: 0, y: 0, z: 0 }, // center (original)
    { x: -24, y: 0, z: -24 }, // NW
    { x: 0, y: 0, z: -24 }, // N
    { x: 24, y: 0, z: -24 }, // NE
    { x: -24, y: 0, z: 0 }, // W
    { x: 24, y: 0, z: 0 }, // E
    { x: -24, y: 0, z: 24 }, // SW
    { x: 0, y: 0, z: 24 }, // S
    { x: 24, y: 0, z: 24 }, // SE
  ];

  /**
   * Jitter a spawn point by generating candidates around it,
   * validating each against BSP collision, and picking a random valid one.
   *
   * If no collision world is set, returns the original point unchanged.
   */
  private jitterSpawn(base: Vec3, rng: () => number = Math.random): Vec3 {
    if (!this.collisionWorld) return base;

    const valid: Vec3[] = [];
    const bounds = GametypeController.PLAYER_BOUNDS;

    for (const offset of GametypeController.JITTER_OFFSETS) {
      const candidate: Vec3 = {
        x: base.x + offset.x,
        y: base.y,
        z: base.z + offset.z,
      };

      // 1. Check if candidate position is inside solid geometry
      const contents = this.collisionWorld.pointContents(candidate);
      if (contents & Contents.SOLID) continue;

      // 2. Box trace: try to "stand" at the candidate with player hull
      //    Trace a tiny downward move — if it starts stuck (fraction=0, hit=true),
      //    the position overlaps geometry
      const traceStart = { ...candidate };
      const traceEnd = { x: candidate.x, y: candidate.y - 1, z: candidate.z };
      const trace = this.collisionWorld.trace(traceStart, traceEnd, bounds);

      // If trace starts in solid (allsolid — fraction=0), skip
      if (trace.fraction === 0 && trace.hit) continue;

      // 3. Find ground: trace downward to snap Y
      const groundStart = { x: candidate.x, y: candidate.y + 8, z: candidate.z };
      const groundEnd = { x: candidate.x, y: candidate.y - 64, z: candidate.z };
      const groundTrace = this.collisionWorld.trace(groundStart, groundEnd, bounds);

      if (groundTrace.hit && groundTrace.hitPoint) {
        // Snap to ground + ORIGIN height (24 units above feet)
        candidate.y = groundTrace.hitPoint.y + 24;
      }

      valid.push(candidate);
    }

    if (valid.length === 0) {
      console.warn(
        `[GametypeController] All spawn candidates rejected! Using base at (${base.x.toFixed(0)}, ${base.y.toFixed(0)}, ${base.z.toFixed(0)})`,
      );
      return base;
    }

    // Pick a valid candidate (seeded → deterministic for demo re-sim, R3b).
    const chosen = valid[Math.floor(rng() * valid.length)];
    console.log(
      `[GametypeController] Spawn jitter: ${valid.length}/9 valid, chose (${chosen.x.toFixed(0)}, ${chosen.y.toFixed(0)}, ${chosen.z.toFixed(0)}) from base (${base.x.toFixed(0)}, ${base.y.toFixed(0)}, ${base.z.toFixed(0)})`,
    );
    return chosen;
  }
}
