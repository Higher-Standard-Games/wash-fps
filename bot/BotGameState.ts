/**
 * BotGameState - World state as perceived by a bot
 *
 * Parses server snapshots into a clean, queryable game state.
 * This is what the BotBrain "sees" and makes decisions from.
 *
 * The bot identifies itself via `selfEntityId` (from JoinAccept) and
 * extracts self state, visible enemies, pickups, and projectiles
 * from snapshot entities, players, and events.
 */

import type { TransformComponent } from "../../../engine/network/components/TransformComponent";
import type { VelocityComponent } from "../../../engine/network/components/VelocityComponent";
import type { GameState, PlayerState } from "../../../engine/network/core/GameState";
import type {
  CombatStateEvent,
  DamageEvent,
  DeathEvent,
  ItemPickupEvent,
  WeaponFireEvent,
  WeaponStateEvent,
} from "../../../engine/network/core/SnapshotEvent";
import { type AgentDirective, MatchPhase } from "../../../shared/server/gametype/index";

// ── Vec3 helper (lightweight, no Babylon.js dependency) ─────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function vec3Subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// ── Perceived entities ──────────────────────────────────────────────────

export interface BotSelf {
  position: Vec3;
  velocity: Vec3;
  pitch: number;
  yaw: number;
  health: number;
  armor: number;
  isDead: boolean;
  isGrounded: boolean;
  isSliding: boolean;
  isCrouching: boolean;
  currentWeapon: string;
  weapons: string[];
  ammo: Record<string, number>;
  isReloading: boolean;
  /** Empty in FFA; stable team id in team modes. */
  team: string;
}

export type PlayerRelation = "ally" | "enemy";

/**
 * Whether a team name from the server means an actual team.
 *
 * In a free-for-all every player's team is "ffa" (older servers and demos
 * sent "spectator"). Neither is a team: read as one, every other player in a
 * Deathmatch would be an ally and a bot would never have anyone to fight.
 */
export function onATeam(team: string | undefined): team is string {
  return team !== undefined && team !== "" && team !== "spectator" && team !== "ffa";
}

export interface VisiblePlayer {
  entityId: string;
  playerId: string;
  position: Vec3;
  velocity: Vec3;
  isDead: boolean;
  /** Empty in FFA. */
  team: string;
  /** Relationship to this bot, derived from replicated player teams. */
  relation: PlayerRelation;
  /** Distance from bot. */
  distance: number;
}

export interface VisiblePickup {
  entityId: string;
  type: string;
  position: Vec3;
  distance: number;
}

export interface VisibleProjectile {
  entityId: string;
  position: Vec3;
  velocity: Vec3;
  ownerId: string;
  /** Is this coming toward us? */
  isThreat: boolean;
  distance: number;
}

// ── Game events the bot cares about ─────────────────────────────────────

export interface BotDamageEvent {
  attackerId: string;
  damage: number;
  weaponId: string;
  position: Vec3;
  tick: number;
}

/**
 * Gametype context the bot reads from `match_state`.
 *
 * Only the fields bot reasoning uses; `MatchStateSnapshot` carries more (HUD
 * scores, spectators, winner) that is of no interest here.
 */
export interface BotMatchState {
  /** Display name, e.g. "Team Deathmatch". Normalized before profile lookup. */
  gametypeName: string;
  /** MatchPhase: 0 warmup, 1 countdown, 2 active, 3 post-game. */
  phase: number;
  /** Per-team round role for alternating modes ("attacker"/"defender"). Phase 6. */
  teamRoles?: Record<string, string>;
  /** Round lifecycle for objective modes ("pre_plant"/"post_plant"). Phase 6. */
  roundState?: string;
  /** Seconds left in the current phase (the match, while active). */
  timeRemaining?: number;
}

export interface BotKillEvent {
  killerId: string;
  victimId: string;
  weaponId: string;
  tick: number;
}

// ── Map knowledge (learned over time) ───────────────────────────────────

export interface MapKnowledge {
  /** Known spawn positions (accumulated from deaths/respawns) */
  spawnPoints: Vec3[];
  /** Known pickup locations (from snapshot entities) */
  pickupLocations: Map<string, Vec3>;
  /** Last time an item was seen picked up (entityId → tick) */
  itemPickupTimes: Map<string, number>;
  /** Danger zones (positions where bot has died multiple times) */
  deathPositions: Vec3[];
}

// ── Ammo normalization ──────────────────────────────────────────────────

/**
 * Flatten the server's per-weapon ammo (`{ clip, reserve }` objects) into a
 * single numeric total per weapon, which is what the bot's decision code
 * (selectBestWeapon, _hasAmmoForWeapon, BotInputNormalizer) all assume. A
 * missing entry means "unlimited" (blade) and is preserved as absent.
 *
 * Without this the bot compared `{ clip, reserve }` objects as numbers —
 * `{ clip: 0, reserve: 0 } <= 0` is false — so it never recognized an empty
 * weapon and kept "firing" it instead of switching.
 */
export function normalizeBotAmmo(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [weaponId, value] of Object.entries(raw)) {
    if (typeof value === "number") {
      out[weaponId] = value;
    } else if (value && typeof value === "object") {
      const clip = Number((value as { clip?: unknown }).clip) || 0;
      const reserve = Number((value as { reserve?: unknown }).reserve) || 0;
      out[weaponId] = clip + reserve;
    }
  }
  return out;
}

/** How close a projectile's path must pass to be worth dodging, in units. */
export const PROJECTILE_THREAT_RADIUS = 150;
/** How far ahead a projectile's path is checked, in seconds. */
const PROJECTILE_THREAT_SECONDS = 1;

/** Whether a projectile at `position` moving at `velocity` passes close to `target` soon. */
export function isIncoming(target: Vec3, position: Vec3, velocity: Vec3): boolean {
  const speedSq = velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z;
  if (speedSq < 1) return false;
  const to = vec3Subtract(target, position);
  const t = (to.x * velocity.x + to.y * velocity.y + to.z * velocity.z) / speedSq;
  if (t <= 0 || t > PROJECTILE_THREAT_SECONDS) return false;
  const closest = vec3Add(position, vec3Scale(velocity, t));
  return vec3Distance(closest, target) <= PROJECTILE_THREAT_RADIUS;
}

// ── Main BotGameState ───────────────────────────────────────────────────

export class BotGameState {
  // Identity
  selfEntityId: string = "";
  selfPlayerId: string = "";

  // Current tick
  tick: number = 0;

  // Self state
  self: BotSelf = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    pitch: 0,
    yaw: 0,
    health: 100,
    armor: 0,
    isDead: false,
    isGrounded: false,
    isSliding: false,
    isCrouching: false,
    currentWeapon: "",
    weapons: [],
    ammo: {},
    isReloading: false,
    team: "",
  };

  // Visible entities
  players: VisiblePlayer[] = [];
  pickups: VisiblePickup[] = [];
  projectiles: VisibleProjectile[] = [];

  /**
   * Enemies this bot only heard this snapshot, placed where the sound came
   * from. Filled by BotPerception; `players` then holds only enemies it sees.
   */
  heardEnemies: VisiblePlayer[] = [];

  /**
   * Every player the snapshot carried, before perception narrows `players`.
   * Only for what the game itself shows a player: a directive's target.
   */
  snapshotPlayers: VisiblePlayer[] = [];

  /**
   * Set by the client when BotPerception decides what this bot knows. The
   * snapshot then only feeds perception: enemy memory and item timing come
   * from what the bot saw or heard, not from the whole server state.
   */
  perceptionManaged = false;

  /**
   * Static-pickup availability, indexed by PickupEntry.id: the server's, or
   * under perception what this bot believes (it saw or heard it go, or saw it
   * back). The server's own stays in `serverPickupMask`.
   */
  pickupActiveMask: readonly boolean[] = [];
  serverPickupMask: readonly boolean[] = [];

  /**
   * Server tick at which each static pickup was last seen taken (its mask bit
   * going from up to down), by PickupEntry.id. Cleared when it is back. With
   * the shared respawn times this says when it returns: item timing.
   */
  itemTakenTick = new Map<number, number>();

  /** Server tick the match last went live, or null before it has. */
  liveSinceTick: number | null = null;

  /**
   * Latest gametype/match context, from the `match_state` snapshot event.
   *
   * The server has always sent this — it is spread into an event once per
   * snapshot — and the bot simply discarded it. It is what lets a bot pick a
   * behavioural weight profile without any protocol change, and from Phase 4 it
   * carries the round role and state that objective modes need.
   */
  matchState: BotMatchState = { gametypeName: "", phase: 0 };

  /**
   * Orders addressed to THIS bot by the gametype, from `agent_directives`.
   *
   * Replaced wholesale each time one arrives, and pruned by expiry every tick,
   * so a directive cannot outlive the server's intent even if the mode stops
   * re-issuing it. Empty for every gametype that issues none.
   */
  directives: AgentDirective[] = [];

  // Recent events (cleared each tick)
  recentDamage: BotDamageEvent[] = [];
  /** Hits this bot landed: the victim's entity, the weapon and when. */
  recentHits: Array<{ victimEntityId: string; weaponId: string; damage: number; tick: number }> = [];
  recentKills: BotKillEvent[] = [];
  /** Every player's name by entity id, bots included; for chat. */
  readonly playerNames = new Map<string, string>();

  // Persistent map knowledge
  mapKnowledge: MapKnowledge = {
    spawnPoints: [],
    pickupLocations: new Map(),
    itemPickupTimes: new Map(),
    deathPositions: [],
  };

  // Player scores
  scores: Map<string, { score: number; deaths: number; team: string }> = new Map();

  /**
   * Major items (armour, Mega Health, powerups) this bot saw or heard each
   * enemy take, by player id: who is likely stacked. Filled by BotPerception.
   */
  enemyMajorItems: Map<string, { type: string; kind: string; tick: number }> = new Map();

  // Last known enemy positions (persists across ticks for hunting)
  lastKnownEnemyPositions: Map<string, { position: Vec3; tick: number }> = new Map();

  /**
   * Update game state from a new server snapshot.
   * Extracts all relevant data for the BotBrain.
   */
  update(snapshot: GameState): void {
    this.tick = snapshot.tick;

    // Clear per-tick data
    this.serverPickupMask = [...snapshot.pickupActiveMask];
    if (!this.perceptionManaged) {
      const previousMask = this.pickupActiveMask;
      this.pickupActiveMask = this.serverPickupMask;
      this.pickupActiveMask.forEach((up, id) => {
        if (up) this.itemTakenTick.delete(id);
        else if (previousMask[id] === true) this.itemTakenTick.set(id, snapshot.tick);
      });
    }
    const selfPlayer = snapshot.players.get(this.selfPlayerId);
    this.self.team = selfPlayer?.team || "";
    this.players = [];
    this.heardEnemies = [];
    this.pickups = [];
    this.projectiles = [];
    this.recentKills = [];

    // Drop directives the server's own expiry has passed. A bot must not keep
    // executing an order the gametype has stopped issuing — expiry is the only
    // guarantee that survives the mode crashing or the round ending.
    if (this.directives.length > 0) {
      this.directives = this.directives.filter((d) => snapshot.tick < d.expiresAtTick);
    }

    // Prune old damage events (keep last 300 ticks for wasRecentlyDamaged)
    this.recentDamage = this.recentDamage.filter((d) => snapshot.tick - d.tick <= 300);
    this.recentHits = this.recentHits.filter((h) => snapshot.tick - h.tick <= 300).slice(-20);
    if (this.recentDamage.length > 50) {
      this.recentDamage = this.recentDamage.slice(-50);
    }

    // ── Process entities ─────────────────────────────────────────────
    // One pass over the roster instead of a roster scan per entity.
    const playerByEntity = new Map<string, { playerId: string; player: PlayerState }>();
    for (const [playerId, player] of snapshot.players) {
      if (player.entityId && playerId !== this.selfPlayerId) playerByEntity.set(player.entityId, { playerId, player });
    }
    for (const [entityId, entity] of snapshot.entities) {
      const transform = entity.getComponent<TransformComponent>("transform");
      const position = transform?.position
        ? { x: transform.position.x, y: transform.position.y, z: transform.position.z }
        : null;

      const velocity = entity.getComponent<VelocityComponent>("velocity");
      const vel = velocity?.linear
        ? { x: velocity.linear.x, y: velocity.linear.y, z: velocity.linear.z }
        : { x: 0, y: 0, z: 0 };

      const grounded = velocity?.grounded ?? false;

      if (!position) continue;

      // Is this our own entity?
      if (entityId === this.selfEntityId) {
        const movementState = entity.getComponent("movementState") as
          | { isSliding?: boolean; isCrouching?: boolean }
          | undefined;
        this.self.position = position;
        this.self.velocity = vel;
        this.self.isGrounded = grounded;
        this.self.isSliding = movementState?.isSliding ?? false;
        this.self.isCrouching = movementState?.isCrouching ?? false;

        // Extract rotation (yaw/pitch)
        if (transform?.rotation) {
          this.self.yaw = transform.rotation.y ?? this.self.yaw;
          this.self.pitch = transform.rotation.x ?? this.self.pitch;
        }
        continue;
      }

      // Is this another player? Check if any player maps to this entityId
      const playerEntry = playerByEntity.get(entityId);
      if (playerEntry) {
        const distance = vec3Distance(this.self.position, position);
        const team = playerEntry.player.team || "";
        const relation: PlayerRelation = onATeam(this.self.team) && team === this.self.team ? "ally" : "enemy";
        this.players.push({
          entityId,
          playerId: playerEntry.playerId,
          position,
          velocity: vel,
          isDead: false, // Will be updated from combat_state events
          team,
          relation,
          distance,
        });

        // Allies must never enter combat memory or become fallback targets.
        // Under perception, only what the bot sees or hears enters it.
        if (this.perceptionManaged) {
          if (relation === "ally") this.lastKnownEnemyPositions.delete(playerEntry.playerId);
        } else if (relation === "enemy") {
          this.lastKnownEnemyPositions.set(playerEntry.playerId, {
            position,
            tick: this.tick,
          });
        } else {
          this.lastKnownEnemyPositions.delete(playerEntry.playerId);
        }
        continue;
      }

      // Projectiles are `proj_<id>` entities. The owner is not replicated.
      if (entityId.startsWith("proj_")) {
        const distance = vec3Distance(this.self.position, position);
        this.projectiles.push({
          entityId,
          position,
          velocity: vel,
          ownerId: "",
          isThreat: isIncoming(this.self.position, position, vel),
          distance,
        });
        continue;
      }

      // Is this a pickup entity? (weaponMeta or item_ prefix)
      // Check for pickup items (weaponMeta component from flag 0x20)
      const weaponMeta = entity.getComponent("weaponMeta") as { weaponId?: string } | undefined;
      if (weaponMeta) {
        const distance = vec3Distance(this.self.position, position);
        this.pickups.push({
          entityId,
          type: weaponMeta.weaponId || "unknown",
          position,
          distance,
        });

        // Learn pickup location
        this.mapKnowledge.pickupLocations.set(entityId, position);
      }
    }

    // ── Process player scores ────────────────────────────────────────
    this.playerNames.clear();
    this.scores.clear();
    for (const [playerId, player] of snapshot.players) {
      if (player.entityId) this.playerNames.set(player.entityId, player.name);
      this.scores.set(playerId, {
        score: player.score,
        deaths: player.deaths,
        team: player.team || "",
      });
    }

    // ── Process events ───────────────────────────────────────────────
    const seenPlayer = new Map(this.players.map((p) => [p.entityId, p]));
    for (const event of snapshot.events) {
      switch (event.type) {
        case "match_state": {
          // Gametype context — drives behavioural weight selection. Sent once
          // per snapshot with the MatchStateSnapshot fields spread in. Read
          // defensively: an older or newer server may omit any of these.
          const evt = event as Partial<{
            gametypeName: unknown;
            phase: unknown;
            teamRoles: unknown;
            roundState: unknown;
            timeRemaining: unknown;
          }>;
          const phase = typeof evt.phase === "number" ? evt.phase : 0;
          if (phase === MatchPhase.Active && this.matchState.phase !== MatchPhase.Active) {
            this.liveSinceTick = snapshot.tick;
          }
          this.matchState = {
            gametypeName: typeof evt.gametypeName === "string" ? evt.gametypeName : "",
            phase,
            teamRoles:
              evt.teamRoles && typeof evt.teamRoles === "object"
                ? (evt.teamRoles as Record<string, string>)
                : undefined,
            roundState: typeof evt.roundState === "string" ? evt.roundState : undefined,
            timeRemaining: typeof evt.timeRemaining === "number" ? evt.timeRemaining : undefined,
          };
          break;
        }

        case "agent_directives": {
          // Only ever sent to the addressed client, but check anyway: a bot
          // must never act on another player's orders, even by server bug.
          const evt = event as { entityId?: unknown; directives?: unknown };
          if (evt.entityId !== this.selfEntityId) break;
          this.directives = Array.isArray(evt.directives) ? (evt.directives as AgentDirective[]) : [];
          break;
        }

        case "combat_state": {
          const evt = event as CombatStateEvent;
          if (evt.entityId === this.selfEntityId) {
            this.self.health = evt.health;
            this.self.armor = evt.armor;
            const wasDead = this.self.isDead;
            this.self.isDead = evt.dead;

            // If we just died, record death position
            if (!wasDead && evt.dead) {
              this.mapKnowledge.deathPositions.push({ ...this.self.position });
            }
          }
          // Mark dead players
          const deadPlayer = seenPlayer.get(evt.entityId);
          if (deadPlayer) {
            deadPlayer.isDead = evt.dead;
          }
          break;
        }

        case "weapon_state": {
          const evt = event as WeaponStateEvent;
          if (evt.entityId === this.selfEntityId) {
            this.self.currentWeapon = evt.currentWeapon || "";
            this.self.weapons = evt.weapons || [];
            this.self.isReloading = evt.reloading || false;
            // Parse + normalize ammo. The server sends per-weapon ammo as
            // { clip, reserve } objects; the bot reasons about a numeric total
            // per weapon (undefined = unlimited). Flatten here so out-of-ammo is
            // detected correctly by every downstream consumer.
            if (evt.ammo) {
              try {
                const raw = typeof evt.ammo === "string" ? JSON.parse(evt.ammo) : evt.ammo;
                this.self.ammo = normalizeBotAmmo(raw);
              } catch {
                // leave previous ammo state intact on malformed payloads
              }
            }
          }
          break;
        }

        case "damage": {
          const evt = event as DamageEvent;
          if (evt.attackerId === this.selfEntityId && evt.entityId !== this.selfEntityId) {
            this.recentHits.push({
              victimEntityId: evt.entityId,
              weaponId: evt.weaponId,
              damage: evt.damage,
              tick: this.tick,
            });
          }
          if (evt.entityId === this.selfEntityId) {
            this.recentDamage.push({
              attackerId: evt.attackerId,
              damage: evt.damage,
              weaponId: evt.weaponId,
              position: { x: evt.x, y: evt.y, z: evt.z },
              tick: this.tick,
            });
          }
          break;
        }

        case "death": {
          const evt = event as DeathEvent;
          this.recentKills.push({
            killerId: evt.killerId,
            victimId: evt.entityId,
            weaponId: evt.weaponId,
            tick: this.tick,
          });
          break;
        }

        case "item_pickup": {
          const evt = event as ItemPickupEvent;
          // Track when items were picked up for respawn timing
          if (evt.pickupId !== undefined) {
            this.mapKnowledge.itemPickupTimes.set(String(evt.pickupId), this.tick);
          }
          break;
        }

        case "weapon_fire": {
          const evt = event as WeaponFireEvent;
          // If someone fires near us, we "hear" it — track as last known position
          // (under perception, BotPerception decides what is heard)
          if (evt.entityId !== this.selfEntityId && !this.perceptionManaged) {
            const firePos = { x: evt.originX, y: evt.originY, z: evt.originZ };
            // Find which player fired
            const firingPlayer = seenPlayer.get(evt.entityId);
            if (firingPlayer?.relation === "enemy") {
              this.lastKnownEnemyPositions.set(firingPlayer.playerId, {
                position: firePos,
                tick: this.tick,
              });
            }
          }
          break;
        }
      }
    }

    // ── Sort by distance ─────────────────────────────────────────────
    this.players.sort((a, b) => a.distance - b.distance);
    this.pickups.sort((a, b) => a.distance - b.distance);
    this.snapshotPlayers = [...this.players];

    // Prune stale enemy positions (older than 600 ticks)
    for (const [key, data] of this.lastKnownEnemyPositions) {
      if (this.tick - data.tick > 600) {
        this.lastKnownEnemyPositions.delete(key);
      }
    }

    // Cap death positions to last 100
    if (this.mapKnowledge.deathPositions.length > 100) {
      this.mapKnowledge.deathPositions = this.mapKnowledge.deathPositions.slice(-100);
    }
  }

  /** Get the nearest alive enemy */
  getNearestEnemy(): VisiblePlayer | null {
    return this.players.find((p) => p.relation === "enemy" && !p.isDead) || null;
  }

  /**
   * Enemies this bot knows to be about: seen or heard now, or remembered from
   * the last `withinTicks`. Without perception, every enemy in the snapshot.
   */
  getKnownEnemyCount(withinTicks: number = 10 * 125): number {
    const known = new Set<string>();
    for (const p of this.players) if (p.relation === "enemy" && !p.isDead) known.add(p.playerId);
    for (const p of this.heardEnemies) known.add(p.playerId);
    for (const [playerId, seen] of this.lastKnownEnemyPositions) {
      if (this.tick - seen.tick <= withinTicks) known.add(playerId);
    }
    return known.size;
  }

  /** Opponents on the scoreboard, which every player can read, seen or not. */
  getScoreboardEnemyCount(): number {
    if (this.scores.size === 0) return this.getKnownEnemyCount();
    let count = 0;
    for (const [playerId, entry] of this.scores) {
      if (playerId === this.selfPlayerId) continue;
      if (onATeam(this.self.team) && entry.team === this.self.team) continue;
      if (entry.team === "spectator" && onATeam(this.self.team)) continue;
      count++;
    }
    return count;
  }

  /** Get the nearest pickup within a max distance */
  getNearestPickup(maxDistance: number = Infinity): VisiblePickup | null {
    return this.pickups.find((p) => p.distance <= maxDistance) || null;
  }

  /**
   * This bot's round role in modes where teams alternate (S&D attacker /
   * defender). Null in FFA, in team modes without roles, or before the first
   * `match_state` arrives.
   */
  getOwnRole(): string | null {
    const roles = this.matchState.teamRoles;
    if (!roles) return null;
    const team = this.self.team || this.scores.get(this.selfPlayerId)?.team;
    if (!team || !onATeam(team)) return null;
    return roles[team] ?? null;
  }

  /** Get all living teammates, nearest first. */
  getAllies(): VisiblePlayer[] {
    return this.players.filter((p) => p.relation === "ally" && !p.isDead);
  }

  /** Check if the bot was recently damaged (within the last N ticks) */
  wasRecentlyDamaged(withinTicks: number = 60): boolean {
    return this.recentDamage.some((d) => this.tick - d.tick <= withinTicks);
  }

  /** Get the most recent attacker's player ID */
  getLastAttacker(): string | null {
    if (this.recentDamage.length === 0) return null;
    return this.recentDamage[this.recentDamage.length - 1].attackerId;
  }

  /** Get own score from player list */
  getOwnScore(): { score: number; deaths: number } {
    const own = this.scores.get(this.selfPlayerId);
    return own ? { score: own.score, deaths: own.deaths } : { score: 0, deaths: 0 };
  }

  /** Count players per team for auto-balance */
  getTeamCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [, data] of this.scores) {
      if (onATeam(data.team)) {
        counts.set(data.team, (counts.get(data.team) || 0) + 1);
      }
    }
    return counts;
  }

  /** Find the team with fewer players */
  getSmallerTeam(): string | undefined {
    const counts = this.getTeamCounts();
    if (counts.size === 0) return undefined;

    let minTeam = "";
    let minCount = Infinity;
    for (const [team, count] of counts) {
      if (count < minCount) {
        minCount = count;
        minTeam = team;
      }
    }
    return minTeam || undefined;
  }
}
