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
import type { MatchConfig, MatchStateSnapshot } from "@shared/server/gametype";
import { MatchPhase } from "@shared/server/gametype";
import type { Vec3 } from "@shared/server/simulation/types";
import type { CollisionWorld } from "../../../../engine/network/systems/collision/CollisionWorld";
import { Contents } from "../../../../engine/network/systems/collision/CollisionWorld";
import { rngFrom } from "../../../../shared/DeterministicRng";
import type { CombatSystem } from "../systems/CombatSystem";
import type { WeaponSystem } from "../systems/WeaponSystem";
import { type AwardEvent, AwardTracker } from "./AwardTracker";
import type { BaseGametype } from "./BaseGametype";
import { MatchState } from "./MatchState";
import { createSpawnStrategy, type SpawnPointStrategy } from "./SpawnPointStrategy";

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
  private respawnQueue: RespawnEntry[] = [];
  private collisionWorld: CollisionWorld | null = null;
  /** Latest sim tick (from postTick) — seeds deterministic spawn selection for
   *  join-time spawns, which happen outside the tick loop (R3b / demo re-sim). */
  private currentTick = 0;
  private botPlayerIds: Set<PlayerId> = new Set();

  private combatSystem: CombatSystem | null = null;
  private weaponSystem: WeaponSystem | null = null;
  private awardTracker = new AwardTracker();
  /** Resolves PlayerId → display name (set by GameServer) */
  private nameResolver: ((playerId: PlayerId) => string) | null = null;

  constructor(gametype: BaseGametype) {
    this.gametype = gametype;
    this.matchConfig = GametypeController.applyEnvOverrides(gametype.getMatchConfig());
    this.matchState = new MatchState(gametype.name, this.matchConfig);
    this.spawnStrategy = createSpawnStrategy(gametype.getSpawnStrategy());

    console.log(`[GametypeController] Initialized: ${gametype.name}`);
    console.log(`[GametypeController] Spawn strategy: ${gametype.getSpawnStrategy()}`);
    console.log(
      `[GametypeController] Score limit: ${this.matchConfig.scoreLimit}, Time limit: ${this.matchConfig.timeLimit}s`,
    );
  }

  /**
   * Dev/test overrides for match pacing via environment variables:
   *   SHAG_TIMELIMIT — match time limit    SHAG_SCORELIMIT — frag/score limit
   *   SHAG_WARMUP    — warmup timeout
   * Time values accept unit suffixes: "2m" = 2 minutes, "90s" or bare "90" =
   * seconds. (Quake's g_timelimit tradition is MINUTES, so a bare tiny value
   * like "2" is almost always a unit mistake — it gets a loud warning.)
   * Read once at server boot; inert when unset. Lobby-spawned servers inherit
   * the lobby process env, so one export covers the whole dev session.
   */
  private static applyEnvOverrides(config: MatchConfig): MatchConfig {
    const env = typeof process !== "undefined" ? process.env : undefined;
    if (!env) return config;

    /** Parse "2m" → 120, "90s"/"90" → 90. Returns null for garbage. */
    const parseSeconds = (raw: string): number | null => {
      const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|s|sec)?$/i);
      if (!m) return null;
      const value = Number(m[1]);
      if (!Number.isFinite(value) || value < 0) return null;
      const unit = (m[2] ?? "s").toLowerCase();
      return unit.startsWith("m") ? value * 60 : value;
    };

    const overridden = { ...config };
    const apply = (key: string, field: "timeLimit" | "scoreLimit" | "warmupTimeout", isTime: boolean) => {
      const raw = env[key];
      if (raw === undefined || raw === "") return;
      const value = isTime ? parseSeconds(raw) : Number(raw);
      if (value === null || !Number.isFinite(value) || value < 0) {
        console.warn(`[GametypeController] Ignoring invalid ${key}="${raw}"`);
        return;
      }
      overridden[field] = value;
      console.log(`[GametypeController] Env override: ${field} = ${value}s (${key}="${raw}")`);
      if (field === "timeLimit" && value > 0 && value < 30) {
        console.warn(
          `[GametypeController] ⚠ ${key}="${raw}" is ${value} SECONDS — the match will end almost immediately. ` +
            `Did you mean "${raw}m" (${value} minutes)?`,
        );
      }
    };
    apply("SHAG_TIMELIMIT", "timeLimit", true);
    apply("SHAG_SCORELIMIT", "scoreLimit", false);
    apply("SHAG_WARMUP", "warmupTimeout", true);
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
  }

  /**
   * Set name resolver for player display names.
   * Called by GameServer after construction.
   */
  setNameResolver(resolver: (playerId: PlayerId) => string): void {
    this.nameResolver = resolver;
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
  setSpawnPoints(points: Vec3[]): void {
    this.spawnPoints = points;
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
        if (teamId) {
          this.matchState.setPlayerTeam(playerId, teamId as any);
        } else {
          this.matchState.assignTeamBalance(playerId, this.gametype.name);
        }
      }
    }

    // For team-based gametypes, spectators don't get spawned
    // For FFA/DM, skip this check — all players spawn
    if (this.gametype.teamBased) {
      const finalTeamId = this.matchState.getPlayerTeam(playerId);
      if (finalTeamId === "spectator") {
        console.log(
          `[GametypeController] Player ${playerId} observing as spectator (${this.matchState.totalPlayers} total)`,
        );
        return null;
      }
    }

    // Delegate to gametype for specific logic (e.g. initial loadout)
    this.gametype.onPlayerJoin(playerId, String(entityId), state, teamId);

    // Choose spawn point
    console.log(
      `[GametypeController] Choosing from ${this.spawnPoints.length} spawn points, collision=${!!this.collisionWorld}`,
    );
    // Seeded from (lastTick, entity) so spawn selection is deterministic for demo
    // re-sim (R3b). Join happens outside the tick loop, so use the latest tick.
    const spawnRng = rngFrom(this.currentTick, entityId as number, 0);
    const baseSpawn = this.spawnStrategy.choose(this.spawnPoints, state, entityId, spawnRng);
    console.log(
      `[GametypeController] Base spawn: (${baseSpawn.x.toFixed(0)}, ${baseSpawn.y.toFixed(0)}, ${baseSpawn.z.toFixed(0)})`,
    );
    const spawn = this.jitterSpawn(baseSpawn, spawnRng);

    // Apply weapon loadout
    if (this.weaponSystem) {
      const loadout = this.gametype.getSpawnLoadout();
      this.weaponSystem.initializeWeaponFromLoadout(entityId, loadout);
    }

    console.log(`[GametypeController] Player ${playerId} joined (${this.matchState.totalPlayers} total)`);
    return spawn;
  }

  /**
   * Handle player disconnect.
   */
  onPlayerDisconnect(playerId: PlayerId): void {
    this.matchState.removePlayer(playerId);
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
    this.matchState.playerReady(playerId);
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

                if (killerTeam === victimTeam) {
                  // Friendly fire / Team kill
                  this.matchState.addScore(killer.ownerId, -1);
                  this.matchState.addTeamScore(killerTeam, -1);
                } else if (killerTeam !== "spectator") {
                  // Enemy kill
                  this.matchState.addScore(killer.ownerId, 1);
                  this.matchState.addTeamScore(killerTeam, 1);
                }
              } else {
                // FFA: any kill is +1
                this.matchState.addScore(killer.ownerId, 1);
              }
            } else if (killer?.ownerId === victim.ownerId) {
              // Suicide
              if (victim.ownerId !== undefined) {
                this.matchState.addScore(victim.ownerId, -1);
                if (this.gametype.teamBased) {
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
    }

    // 2. Process respawn queue
    this.processRespawns(state, tickNum);

    // 3. Update match state
    const phaseChanged = this.matchState.update(dt);
    if (phaseChanged) {
      this.gametype.onMatchPhaseChange(this.matchState.phase, state);

      // On match start (countdown → active), respawn all players
      if (this.matchState.phase === MatchPhase.Active) {
        this.respawnAllPlayers(state, tickNum);
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

    // 4. Check win condition during active phase
    if (this.matchState.phase === MatchPhase.Active) {
      const config = this.matchConfig;
      if (config.scoreLimit > 0) {
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

    // Choose spawn point using strategy — seeded for deterministic re-sim (R3b).
    const spawnRng = rngFrom(tickNum, entityId as number, 0);
    const baseSpawn = this.spawnStrategy.choose(this.spawnPoints, state, entityId, spawnRng);
    const spawn = this.jitterSpawn(baseSpawn, spawnRng);

    // Get loadout from gametype
    const loadout = this.gametype.getSpawnLoadout();

    // Reset health/armor
    if (entity.health) {
      entity.health.health = loadout.health;
      entity.health.armor = loadout.armor;
      entity.health.dead = false;
    }

    // Set position
    if (entity.transform) {
      entity.transform.position = { ...spawn };
    }

    // Reset velocity
    if (entity.physics) {
      entity.physics.velocity = { x: 0, y: 0, z: 0 };
      entity.physics.grounded = false;
      entity.physics.jumping = false;
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
      entity.input.wantsRespawn = false;
    }

    console.log(
      `[GametypeController] Respawned entity ${entityId} at (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)}, ${spawn.z.toFixed(0)})`,
    );
  }

  private respawnAllPlayers(state: WorldState, tickNum: number): void {
    console.log(`[GametypeController] Match start — respawning all players`);
    for (const entity of state.allEntities()) {
      if (entity.ownerId !== undefined) {
        this.respawnPlayer(state, entity.id, tickNum);
      }
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
    if (this.matchState.phase !== MatchPhase.PostGame) return;

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

  getMatchState(): MatchState {
    return this.matchState;
  }

  getMatchSnapshot(): MatchStateSnapshot {
    return this.matchState.toSnapshot();
  }

  getGametype(): BaseGametype {
    return this.gametype;
  }

  getPhase(): MatchPhase {
    return this.matchState.phase;
  }

  getSpawnPoint(state: WorldState, entityId?: EntityId): Vec3 {
    const spawnRng = rngFrom(this.currentTick, (entityId ?? 0) as number, 0);
    const base = this.spawnStrategy.choose(this.spawnPoints, state, entityId, spawnRng);
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
