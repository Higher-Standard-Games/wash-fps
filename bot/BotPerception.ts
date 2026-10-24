/**
 * BotPerception — what a bot knows, from what it can see and hear.
 *
 * The server sends a client every player in its map area, through walls, and
 * the full pickup mask; a bot used to act on all of it. This runs after each
 * snapshot is read and leaves in BotGameState only what a player in the bot's
 * place would know:
 *
 * - `players` keeps allies and the enemies it sees: in line of sight and inside
 *   a 110° view cone (out to 140° for one that is moving), or seen in the last
 *   second while still in line of sight. A newly seen enemy registers after
 *   half the reaction time; the view turn adds the rest.
 * - `heardEnemies` holds enemies only heard, where the sound came from: shots,
 *   explosions near them, footsteps, jumps and landings, pain, pickups.
 * - Enemy memory (`lastKnownEnemyPositions`) is fed only from those.
 * - `pickupActiveMask` and `itemTakenTick` become what the bot believes: an
 *   item goes down when it saw or heard it taken or found the spot empty, and
 *   comes back when its estimated respawn passes or it sees it there.
 *   `itemTimingSkill` sets how often a heard pickup is noted and how far off
 *   the remembered time is.
 *
 * Sound ranges are the same for every difficulty; the skill is in noticing.
 */

import type { GameState } from "../../../engine/network/core/GameState";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../shared/server/simulation/physics/constants";
import type { PickupEntry } from "../shared/bsp/PickupTable";
import { itemRespawnSeconds } from "../shared/items/ItemRespawn";
import type { BotDifficulty } from "./BotConfig";
import { type BotGameState, onATeam, type Vec3, type VisiblePlayer, vec3Distance } from "./BotGameState";
import { isMajorItem } from "./goals/considerations/ItemFacts";

const DEG = Math.PI / 180;

/** How far each sound carries, in units. */
export const HEARING_RANGE = {
  fire: 1200,
  loudFire: 2000,
  explosion: 1500,
  footsteps: 500,
  movement: 800,
  pain: 800,
  pickup: 900,
  majorPickup: 2500,
} as const;

const LOUD_WEAPONS = new Set(["rlauncher", "glauncher", "electrobolt"]);
/** An explosion this close to an enemy gives them away. */
const EXPLOSION_REVEAL_RADIUS = 200;

const VIEW_HALF_ANGLE = 55 * DEG;
const PERIPHERAL_HALF_ANGLE = 70 * DEG;
/** Seen within this long, an enemy stays seen while in line of sight, wherever the view points. */
const KEEP_SEEN_TICKS = TICK_RATE;
/** Horizontal speed that makes footsteps and catches the eye at the edge of view. */
const RUNNING_SPEED = 250;
/** Upward speed that marks a jump from the ground. */
const JUMP_SPEED = 200;
/** Downward speed at touchdown that makes a landing heard. */
const LANDING_SPEED = 450;
/** Line-of-sight checks per snapshot, nearest enemies first. */
const MAX_LOS_CHECKS = 8;
/** Item spots checked per snapshot for whether they are there or gone. */
const MAX_ITEM_CHECKS = 4;
/** Items further than this cannot be told apart from the spot. */
const ITEM_SIGHT_RANGE = 2000;

export interface PerceptionInput {
  state: BotGameState;
  snapshot: GameState;
  /** Where the bot is looking (the view it sends, not where it wants to look). */
  viewYaw: number;
  /** Line of sight between two origins (feet), or null with no map: then the bot knows everything, as before. */
  canSee: ((from: Vec3, to: Vec3, entityId?: string) => boolean) | null;
  pickups: readonly PickupEntry[];
}

interface Sighting {
  firstTick: number;
  lastTick: number;
}

interface Mover {
  grounded: boolean;
  velocityY: number;
}

interface ItemBelief {
  up: boolean;
  /** Remembered taken tick, with this bot's error in it. */
  takenTick?: number;
}

type Difficulty = Pick<BotDifficulty, "reactionTimeMs" | "itemTimingSkill">;

export class BotPerception {
  private _difficulty: Difficulty;
  private readonly _sightings = new Map<string, Sighting>();
  private readonly _movers = new Map<string, Mover>();
  private readonly _items = new Map<number, ItemBelief>();
  private _itemCursor = 0;

  constructor(
    difficulty: Difficulty,
    private readonly _random: () => number = Math.random,
  ) {
    this._difficulty = difficulty;
  }

  setDifficulty(difficulty: Difficulty): void {
    this._difficulty = difficulty;
  }

  /** Forget everything, as on a new map or connection. */
  reset(): void {
    this._sightings.clear();
    this._movers.clear();
    this._items.clear();
    this._itemCursor = 0;
  }

  perceive(input: PerceptionInput): void {
    const { state, canSee } = input;
    if (!canSee) {
      state.perceptionManaged = false;
      return;
    }
    if (!state.perceptionManaged) {
      // This snapshot was read before perception took over: drop what it learned unseen.
      state.lastKnownEnemyPositions.clear();
      state.perceptionManaged = true;
    }

    const heard = this._hear(input);
    this._sortPlayers(input, heard);
    this._believeItems(input);
  }

  // ── Enemies ─────────────────────────────────────────────────────────

  private _sortPlayers(input: PerceptionInput, heard: Map<string, Vec3>): void {
    const { state, viewYaw, canSee } = input;
    const eyeFrom = state.self.position;
    const noticeTicks = Math.round(((this._difficulty.reactionTimeMs * 0.5) / 1000) * TICK_RATE);
    const kept: VisiblePlayer[] = [];
    const seenIds = new Set<string>();
    let checks = 0;

    for (const player of state.players) {
      if (player.relation === "ally") {
        kept.push(player);
        continue;
      }
      let seen = false;
      if (!player.isDead && checks < MAX_LOS_CHECKS) {
        const sighting = this._sightings.get(player.playerId);
        const recent = sighting !== undefined && state.tick - sighting.lastTick <= KEEP_SEEN_TICKS;
        const off = Math.abs(angleTo(eyeFrom, player.position, viewYaw));
        const moving = Math.hypot(player.velocity.x, player.velocity.z) > RUNNING_SPEED;
        const inView = off <= VIEW_HALF_ANGLE || (moving && off <= PERIPHERAL_HALF_ANGLE);
        if (recent || inView || heard.has(player.playerId)) {
          checks++;
          if (canSee?.(eyeFrom, player.position, player.entityId)) {
            const next = recent && sighting ? sighting : { firstTick: state.tick, lastTick: state.tick };
            next.lastTick = state.tick;
            this._sightings.set(player.playerId, next);
            seen = state.tick - next.firstTick >= noticeTicks;
          }
        }
      }
      if (seen) {
        seenIds.add(player.playerId);
        kept.push(player);
        state.lastKnownEnemyPositions.set(player.playerId, { position: { ...player.position }, tick: state.tick });
        continue;
      }
      const sound = heard.get(player.playerId);
      if (sound) this._addHeard(state, player, sound);
    }

    // Enemies outside the bot's map area can still be heard.
    for (const [playerId, sound] of heard) {
      if (seenIds.has(playerId) || state.heardEnemies.some((p) => p.playerId === playerId)) continue;
      if (state.players.some((p) => p.playerId === playerId)) continue;
      const entry = input.snapshot.players.get(playerId);
      if (!entry) continue;
      const team = entry.team || "";
      const ally = onATeam(state.self.team) && team === state.self.team;
      if (ally) continue;
      this._addHeard(
        state,
        {
          entityId: entry.entityId,
          playerId,
          position: sound,
          velocity: { x: 0, y: 0, z: 0 },
          isDead: false,
          team,
          relation: "enemy",
          distance: 0,
        },
        sound,
      );
    }

    for (const [playerId, sighting] of this._sightings) {
      if (state.tick - sighting.lastTick > KEEP_SEEN_TICKS) this._sightings.delete(playerId);
    }
    state.players = kept;
    state.heardEnemies.sort((a, b) => a.distance - b.distance);
  }

  private _addHeard(state: BotGameState, player: VisiblePlayer, sound: Vec3): void {
    state.heardEnemies.push({
      ...player,
      position: { ...sound },
      velocity: { x: 0, y: 0, z: 0 },
      distance: vec3Distance(state.self.position, sound),
    });
    state.lastKnownEnemyPositions.set(player.playerId, { position: { ...sound }, tick: state.tick });
  }

  /** Sounds this snapshot, by the player who made them: where each was heard from. */
  private _hear(input: PerceptionInput): Map<string, Vec3> {
    const { state, snapshot } = input;
    const self = state.self.position;
    const heard = new Map<string, Vec3>();
    const byEntity = new Map<string, string>();
    for (const [playerId, player] of snapshot.players) {
      if (player.entityId && playerId !== state.selfPlayerId) byEntity.set(String(player.entityId), playerId);
    }
    const hear = (entityId: unknown, at: Vec3, range: number) => {
      const playerId = byEntity.get(String(entityId));
      if (!playerId || !finite(at) || vec3Distance(self, at) > range) return;
      heard.set(playerId, at);
    };
    const explosions: Vec3[] = [];

    for (const event of snapshot.events) {
      const e = event as Record<string, unknown>;
      switch (e.type) {
        case "weapon_fire":
          hear(
            e.entityId,
            xyz(e.originX, e.originY, e.originZ),
            LOUD_WEAPONS.has(String(e.weaponId)) ? HEARING_RANGE.loudFire : HEARING_RANGE.fire,
          );
          break;
        case "electro_rail":
          hear(e.entityId, xyz(e.originX, e.originY, e.originZ), HEARING_RANGE.loudFire);
          break;
        case "voltaic_beam":
          hear(e.entityId, xyz(e.originX, e.originY, e.originZ), HEARING_RANGE.fire);
          break;
        case "damage":
          // The victim's pain is heard; being hit shows where it came from.
          hear(e.entityId, xyz(e.x, e.y, e.z), HEARING_RANGE.pain);
          if (e.entityId === state.selfEntityId) {
            const attacker = snapshot.entities.get(String(e.attackerId));
            const at = attacker ? entityPosition(attacker) : null;
            if (at) hear(e.attackerId, at, Number.POSITIVE_INFINITY);
          }
          break;
        case "item_pickup": {
          const pickup = input.pickups.find((p) => p.id === e.pickupId);
          const loud = pickup !== undefined && isMajorItem(pickup.type, pickup.kind);
          const at = xyz(e.x, e.y, e.z);
          hear(e.entityId, at, loud ? HEARING_RANGE.majorPickup : HEARING_RANGE.pickup);
          const taker = byEntity.get(String(e.entityId));
          const takerTeam = taker ? snapshot.players.get(taker)?.team : undefined;
          const ally = onATeam(state.self.team) && takerTeam === state.self.team;
          if (loud && pickup && taker && !ally && finite(at) && vec3Distance(self, at) <= HEARING_RANGE.majorPickup) {
            state.enemyMajorItems.set(taker, { type: pickup.type, kind: pickup.kind, tick: state.tick });
          }
          break;
        }
        case "death": {
          // A fragged enemy respawns with nothing.
          const victim = byEntity.get(String(e.entityId));
          if (victim) state.enemyMajorItems.delete(victim);
          break;
        }
        case "projectile_impact": {
          const at = xyz(e.x, e.y, e.z);
          if (finite(at) && vec3Distance(self, at) <= HEARING_RANGE.explosion) explosions.push(at);
          break;
        }
      }
    }

    // Movement sounds, worked out from the snapshot as a player's client does
    // for footsteps (FPSMovementAudio), and explosions next to someone.
    const alive = new Set<string>();
    for (const player of state.players) {
      if (player.relation !== "enemy" || player.isDead) continue;
      alive.add(player.entityId);
      const before = this._movers.get(player.entityId);
      const entity = snapshot.entities.get(player.entityId);
      const grounded = groundedOf(entity) ?? before?.grounded ?? true;
      const d = player.distance;
      const speed = Math.hypot(player.velocity.x, player.velocity.z);
      if (grounded && speed > RUNNING_SPEED && d <= HEARING_RANGE.footsteps)
        heard.set(player.playerId, player.position);
      if (before?.grounded && !grounded && player.velocity.y > JUMP_SPEED && d <= HEARING_RANGE.movement) {
        heard.set(player.playerId, player.position);
      }
      if (before && !before.grounded && grounded && -before.velocityY > LANDING_SPEED && d <= HEARING_RANGE.movement) {
        heard.set(player.playerId, player.position);
      }
      if (explosions.some((at) => vec3Distance(at, player.position) <= EXPLOSION_REVEAL_RADIUS)) {
        heard.set(player.playerId, player.position);
      }
      this._movers.set(player.entityId, { grounded, velocityY: player.velocity.y });
    }
    for (const id of this._movers.keys()) if (!alive.has(id)) this._movers.delete(id);
    return heard;
  }

  // ── Items ───────────────────────────────────────────────────────────

  private _believeItems(input: PerceptionInput): void {
    const { state, snapshot, canSee, pickups } = input;
    const server = state.serverPickupMask;
    if (server.length === 0 || pickups.length === 0) {
      state.pickupActiveMask = server;
      return;
    }
    const skill = Math.max(0, Math.min(1, this._difficulty.itemTimingSkill));
    const errorTicks = Math.max(0.5, 7.83 - 8.33 * skill) * TICK_RATE;
    const remember = (id: number, takenTick: number) => {
      const off = (this._random() * 2 - 1) * errorTicks;
      this._items.set(id, { up: false, takenTick: Math.round(takenTick + off) });
    };
    const respawnTicks = (entry: PickupEntry) => Math.round(itemRespawnSeconds(entry.type, entry.kind) * TICK_RATE);

    // Pickups heard (or made) this snapshot.
    for (const event of snapshot.events) {
      const e = event as Record<string, unknown>;
      if (e.type !== "item_pickup" || typeof e.pickupId !== "number") continue;
      const entry = pickups.find((p) => p.id === e.pickupId);
      if (!entry) continue;
      const mine = String(e.entityId) === state.selfEntityId;
      const range = isMajorItem(entry.type, entry.kind) ? HEARING_RANGE.majorPickup : HEARING_RANGE.pickup;
      const near = vec3Distance(state.self.position, entry.position) <= range;
      if (mine) this._items.set(entry.id, { up: false, takenTick: state.tick });
      else if (near && this._random() < skill) remember(entry.id, state.tick);
    }

    // A few spots looked at each snapshot: the ones the bot is wrong about first.
    const wrong = pickups.filter(
      (entry) => (server[entry.id] ?? true) !== this._believedUp(entry, state.tick, respawnTicks),
    );
    const order = wrong.length > 0 ? wrong : pickups;
    for (let n = 0; n < Math.min(MAX_ITEM_CHECKS, order.length); n++) {
      const entry = order[(this._itemCursor + n) % order.length];
      const lift = { x: entry.position.x, y: entry.position.y - 24, z: entry.position.z };
      if (vec3Distance(state.self.position, entry.position) > ITEM_SIGHT_RANGE) continue;
      if (Math.abs(angleTo(state.self.position, entry.position, input.viewYaw)) > VIEW_HALF_ANGLE) continue;
      if (!canSee?.(state.self.position, lift)) continue;
      const up = server[entry.id] ?? true;
      const belief = this._items.get(entry.id);
      if (up) this._items.delete(entry.id);
      else if (!belief || belief.up) {
        // Found gone: taken some time in the last respawn period.
        remember(entry.id, state.tick - Math.round(respawnTicks(entry) / 2));
      }
    }
    this._itemCursor = (this._itemCursor + MAX_ITEM_CHECKS) % Math.max(1, order.length);

    const mask: boolean[] = [];
    state.itemTakenTick.clear();
    for (const entry of pickups) {
      const up = this._believedUp(entry, state.tick, respawnTicks);
      mask[entry.id] = up;
      const belief = this._items.get(entry.id);
      if (!up && belief?.takenTick !== undefined) state.itemTakenTick.set(entry.id, belief.takenTick);
    }
    for (let id = 0; id < server.length; id++) if (mask[id] === undefined) mask[id] = server[id];
    state.pickupActiveMask = mask;
  }

  private _believedUp(entry: PickupEntry, tick: number, respawnTicks: (entry: PickupEntry) => number): boolean {
    const belief = this._items.get(entry.id);
    if (!belief || belief.up) return true;
    if (belief.takenTick !== undefined && tick >= belief.takenTick + respawnTicks(entry)) {
      this._items.delete(entry.id);
      return true;
    }
    return false;
  }
}

/** Angle from the view yaw to `to`, wrapped to (−π, π]. */
function angleTo(from: Vec3, to: Vec3, viewYaw: number): number {
  const bearing = Math.atan2(to.x - from.x, to.z - from.z);
  return Math.atan2(Math.sin(bearing - viewYaw), Math.cos(bearing - viewYaw));
}

function xyz(x: unknown, y: unknown, z: unknown): Vec3 {
  return { x: Number(x), y: Number(y), z: Number(z) };
}

function finite(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

type EntityLike = { getComponent(name: string): unknown };

function entityPosition(entity: EntityLike): Vec3 | null {
  const transform = entity.getComponent("transform") as { position?: Vec3 } | undefined;
  return transform?.position ? { x: transform.position.x, y: transform.position.y, z: transform.position.z } : null;
}

function groundedOf(entity: EntityLike | undefined): boolean | undefined {
  const velocity = entity?.getComponent("velocity") as { grounded?: boolean } | undefined;
  return velocity?.grounded;
}
