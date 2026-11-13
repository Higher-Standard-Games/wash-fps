/**
 * MatchRead — what a bot knows about how the match is going, kept the way a
 * player keeps it: from what it saw, heard and did.
 *
 * Fed once per decision with the bot's perceived state (after BotPerception),
 * so it never knows more than a player in its place would. It keeps:
 *
 * - its own stack (health + armor) over time;
 * - an estimate of each enemy's health and armor: spawn values on a respawn,
 *   the hits it lands split by the server's armor rule (armor takes 66% of
 *   a hit while it lasts), clamped to the pain tier the hit's pain sound
 *   gives away, plus the major items it saw or heard them take, by the same
 *   pickup rules as the server. The estimate grows uncertain while the enemy
 *   is out of sight;
 * - who took the major items (armors, Mega Health, powerups), and when;
 * - each fight: when, where, the stacks at the start, damage dealt and taken,
 *   who was seen first, and how it ended;
 * - the score, from the scoreboard every client gets.
 *
 * Plain bookkeeping, no model. Diagnosis (`Diagnosis.ts`) reads it.
 */

import { type ArmorKind, armorAfterPickup, type HealthKind, healthAfterPickup } from "../../shared/items/ItemGrants";
import type { BotGameState, Vec3 } from "../BotGameState";

const TICK_RATE = 125;
/** Armor takes this share of a hit while it lasts (CombatSystem BASE_ARMOR_ABSORPTION). */
export const ARMOR_ABSORPTION = 0.66;
export const SPAWN_HEALTH = 100;
/** A fight ends this long after the last contact (sight or damage either way). */
const FIGHT_GAP_TICKS = 3 * TICK_RATE;
/** Own stack is sampled this often for averages. */
const STACK_SAMPLE_TICKS = TICK_RATE / 2;
/** Samples and fights older than this are dropped. */
const MEMORY_TICKS = 180 * TICK_RATE;
/** Out of sight for this long, an estimate counts as unknown (uncertainty 1). */
const ESTIMATE_FADE_TICKS = 15 * TICK_RATE;
/** Health range each pain tier stands for (SnapshotBuilder.painTier). */
const PAIN_TIER_RANGE: readonly (readonly [number, number])[] = [
  [1, 20],
  [21, 35],
  [36, 60],
  [61, 200],
];

export interface EnemyEstimate {
  entityId: string;
  health: number;
  armor: number;
  /** Last tick anything was learned about them. */
  knownTick: number;
  /** Last tick seen. */
  seenTick: number;
  /** When this life began, as near as the bot knows: first seen alive again. */
  spawnTick: number;
  alive: boolean;
}

export interface MajorTake {
  type: string;
  kind: string;
  /** "self", or the taker's player id. */
  by: string;
  tick: number;
  /** Which pickup, when known (enemies' takes heard or seen). */
  pickupId?: number;
}

export interface Fight {
  enemy: string;
  startTick: number;
  lastContactTick: number;
  /** Map cell, 256 units: where the fight started. */
  cell: string;
  ownStackAtStart: number;
  enemyStackAtStart: number;
  dealt: number;
  taken: number;
  /** Whether this bot saw the enemy before taking any damage. */
  sawFirst: boolean;
  result: "open" | "kill" | "death" | "apart";
}

export interface ScoreRead {
  own: number;
  /** Own deaths so far. */
  deaths: number;
  /** Best score among the others. */
  bestOther: number;
  timeRemaining: number | undefined;
}

export class MatchRead {
  /**
   * @param typicalStack the stack an enemy typically has so many seconds after
   *   spawning (PeopleProfile, for people), or null: an estimate gone stale
   *   leans on it, since players pick items up out of sight. Without one a
   *   stale estimate stays as it was last known.
   */
  constructor(
    private readonly _typicalStack: ((secondsAlive: number, entityId: string) => number | null) | null = null,
  ) {}

  private _tick = 0;
  private _lastStackSample = Number.NEGATIVE_INFINITY;
  private readonly _stacks: { tick: number; stack: number }[] = [];
  private readonly _enemies = new Map<string, EnemyEstimate>();
  private readonly _takes: MajorTake[] = [];
  private readonly _fights: Fight[] = [];
  /** Who hurt this bot, and when. */
  private readonly _attacks: { attacker: string; tick: number }[] = [];
  private _lastHitTick = Number.NEGATIVE_INFINITY;
  private _lastDamageTick = Number.NEGATIVE_INFINITY;
  private _lastEnemyItemTicks = new Map<string, number>();
  private _wasDead = true;
  private _prev = { health: SPAWN_HEALTH, armor: 0 };
  private _score: ScoreRead = { own: 0, deaths: 0, bestOther: 0, timeRemaining: undefined };

  get tick(): number {
    return this._tick;
  }

  reset(): void {
    this._stacks.length = 0;
    this._enemies.clear();
    this._takes.length = 0;
    this._fights.length = 0;
    this._attacks.length = 0;
    this._lastEnemyItemTicks.clear();
    this._lastHitTick = Number.NEGATIVE_INFINITY;
    this._lastDamageTick = Number.NEGATIVE_INFINITY;
    this._lastStackSample = Number.NEGATIVE_INFINITY;
    this._wasDead = true;
  }

  /** Take in one decision's perceived state. */
  update(state: BotGameState): void {
    const tick = state.tick;
    this._tick = tick;
    const self = state.self;

    // Own stack, and own major pickups from what the bot gained.
    if (!self.isDead) {
      if (this._wasDead) this._prev = { health: self.health, armor: self.armor };
      const gainedArmor = self.armor - this._prev.armor;
      const gainedHealth = self.health - this._prev.health;
      if (gainedArmor >= 50)
        this._takes.push({ type: "armor", kind: gainedArmor >= 75 ? "ra" : "ya", by: "self", tick });
      if (gainedHealth >= 75) this._takes.push({ type: "health", kind: "mega", by: "self", tick });
      this._prev = { health: self.health, armor: self.armor };
      if (tick - this._lastStackSample >= STACK_SAMPLE_TICKS) {
        this._stacks.push({ tick, stack: self.health + self.armor });
        this._lastStackSample = tick;
      }
    }

    // Enemies in sight: a respawn resets the estimate.
    for (const player of state.players) {
      if (player.relation !== "enemy") continue;
      const known = this._enemies.get(player.entityId);
      if (player.isDead) {
        if (known) known.alive = false;
        continue;
      }
      if (!known?.alive) {
        this._enemies.set(player.entityId, {
          entityId: player.entityId,
          health: SPAWN_HEALTH,
          armor: 0,
          knownTick: tick,
          seenTick: tick,
          spawnTick: tick,
          alive: true,
        });
      } else known.seenTick = tick;
    }

    // Hits this bot landed: the armor rule, then the pain tier the hit gave away.
    for (const hit of state.recentHits) {
      if (hit.tick <= this._lastHitTick) continue;
      const enemy = this._estimate(hit.victimEntityId, tick);
      applyHit(enemy, hit.damage, hit.painTier);
      enemy.knownTick = tick;
      this._contact(hit.victimEntityId, tick, state, { dealt: hit.damage });
    }
    if (state.recentHits.length > 0)
      this._lastHitTick = Math.max(this._lastHitTick, ...state.recentHits.map((h) => h.tick));

    // Damage taken.
    for (const hurt of state.recentDamage) {
      if (hurt.tick <= this._lastDamageTick) continue;
      if (hurt.attackerId && hurt.attackerId !== state.selfEntityId) {
        this._contact(hurt.attackerId, tick, state, { taken: hurt.damage });
        this._attacks.push({ attacker: hurt.attackerId, tick });
      }
    }
    if (state.recentDamage.length > 0)
      this._lastDamageTick = Math.max(this._lastDamageTick, ...state.recentDamage.map((d) => d.tick));

    // Major items enemies were seen or heard taking.
    for (const [playerId, item] of state.enemyMajorItems) {
      if (this._lastEnemyItemTicks.get(playerId) === item.tick) continue;
      this._lastEnemyItemTicks.set(playerId, item.tick);
      this._takes.push({ type: item.type, kind: item.kind, by: playerId, tick: item.tick, pickupId: item.pickupId });
      const entityId = entityOfPlayer(state, playerId);
      if (entityId) applyPickup(this._estimate(entityId, tick), item.type, item.kind);
    }

    // Seen enemies keep a fight open.
    for (const player of state.players)
      if (player.relation === "enemy" && !player.isDead) this._contact(player.entityId, tick, state, {});

    // Kills and deaths end fights.
    for (const kill of state.recentKills) {
      if (kill.killerId === state.selfEntityId && kill.victimId !== state.selfEntityId) {
        const enemy = this._enemies.get(kill.victimId);
        if (enemy) enemy.alive = false;
        this._end(kill.victimId, "kill");
      }
    }
    // The brain is not asked to decide while its bot is dead, so a death shows
    // as one more on the scoreboard by the first decision after it.
    const score = readScore(state);
    if (score.deaths > this._score.deaths) {
      for (const fight of this._fights) if (fight.result === "open") fight.result = "death";
    }
    for (const fight of this._fights)
      if (fight.result === "open" && tick - fight.lastContactTick > FIGHT_GAP_TICKS) fight.result = "apart";
    this._wasDead = self.isDead;
    this._score = score;
    this._forget(tick);
  }

  /** Own health + armor now. */
  ownStack(state: BotGameState): number {
    return state.self.health + state.self.armor;
  }

  /** Own average stack over the last `seconds`, while alive; NaN with no samples. */
  averageOwnStack(seconds: number): number {
    const from = this._tick - seconds * TICK_RATE;
    const recent = this._stacks.filter((s) => s.tick >= from);
    return recent.length > 0 ? recent.reduce((sum, s) => sum + s.stack, 0) / recent.length : Number.NaN;
  }

  /** The estimate for an enemy, or null if never met. */
  enemy(entityId: string): EnemyEstimate | null {
    return this._enemies.get(entityId) ?? null;
  }

  /**
   * Estimated stack of an enemy, and how unsure it is (0 just learned, 1 long
   * out of sight). As the estimate goes stale it leans, by its uncertainty,
   * toward the stack people typically have that long after spawning, when that
   * is higher than what the bot last knew.
   */
  enemyStack(entityId: string): { stack: number; uncertainty: number } | null {
    const enemy = this._enemies.get(entityId);
    if (!enemy?.alive) return null;
    const uncertainty = Math.min(1, (this._tick - enemy.knownTick) / ESTIMATE_FADE_TICKS);
    const known = enemy.health + enemy.armor;
    const typical = this._typicalStack?.((this._tick - enemy.spawnTick) / TICK_RATE, entityId) ?? null;
    const stack = typical !== null && typical > known ? known + uncertainty * (typical - known) : known;
    return { stack, uncertainty };
  }

  /** Enemies met, most recently learned about first. */
  enemies(): EnemyEstimate[] {
    return [...this._enemies.values()].sort((a, b) => b.knownTick - a.knownTick);
  }

  /** Major items taken in the last `seconds`, by this bot and by others. */
  majorTakes(seconds: number): { own: number; others: number; takes: readonly MajorTake[] } {
    const from = this._tick - seconds * TICK_RATE;
    const takes = this._takes.filter((t) => t.tick >= from);
    const own = takes.filter((t) => t.by === "self").length;
    return { own, others: takes.length - own, takes };
  }

  /** The fight under way with an enemy, if any. */
  openFight(enemy: string): Fight | null {
    return this._fights.find((f) => f.enemy === enemy && f.result === "open") ?? null;
  }

  /** Fights that started in the last `seconds`, oldest first. */
  fights(seconds: number): readonly Fight[] {
    const from = this._tick - seconds * TICK_RATE;
    return this._fights.filter((f) => f.startTick >= from);
  }

  score(): ScoreRead {
    return this._score;
  }

  /** How many different enemies hurt this bot in the last `seconds`. */
  attackers(seconds: number): number {
    const from = this._tick - seconds * TICK_RATE;
    return new Set(this._attacks.filter((a) => a.tick >= from).map((a) => a.attacker)).size;
  }

  private _estimate(entityId: string, tick: number): EnemyEstimate {
    let enemy = this._enemies.get(entityId);
    if (!enemy) {
      enemy = { entityId, health: SPAWN_HEALTH, armor: 0, knownTick: tick, seenTick: -1, spawnTick: tick, alive: true };
      this._enemies.set(entityId, enemy);
    }
    return enemy;
  }

  private _contact(enemy: string, tick: number, state: BotGameState, add: { dealt?: number; taken?: number }): void {
    let fight = this._fights.find((f) => f.enemy === enemy && f.result === "open");
    if (!fight) {
      const at = state.self.position;
      const estimate = this.enemyStack(enemy);
      fight = {
        enemy,
        startTick: tick,
        lastContactTick: tick,
        cell: cellOf(at),
        ownStackAtStart: state.self.health + state.self.armor,
        enemyStackAtStart: estimate?.stack ?? SPAWN_HEALTH,
        dealt: 0,
        taken: 0,
        sawFirst: !add.taken,
        result: "open",
      };
      this._fights.push(fight);
    }
    fight.lastContactTick = tick;
    fight.dealt += add.dealt ?? 0;
    fight.taken += add.taken ?? 0;
  }

  private _end(enemy: string, result: Fight["result"]): void {
    for (const fight of this._fights) if (fight.enemy === enemy && fight.result === "open") fight.result = result;
  }

  private _forget(tick: number): void {
    const from = tick - MEMORY_TICKS;
    while (this._stacks.length > 0 && this._stacks[0].tick < from) this._stacks.shift();
    while (this._takes.length > 0 && this._takes[0].tick < from) this._takes.shift();
    while (this._attacks.length > 0 && this._attacks[0].tick < from) this._attacks.shift();
    while (this._fights.length > 0 && this._fights[0].startTick < from && this._fights[0].result !== "open")
      this._fights.shift();
  }
}

/** A hit of `damage` (before armor) on `enemy`, then the pain tier's health range when known. */
export function applyHit(enemy: { health: number; armor: number }, damage: number, painTier?: number): void {
  const absorbed = Math.min(enemy.armor, damage * ARMOR_ABSORPTION);
  enemy.armor = Math.max(0, enemy.armor - absorbed);
  enemy.health = Math.max(1, enemy.health - (damage - absorbed));
  const range = painTier !== undefined ? PAIN_TIER_RANGE[painTier] : undefined;
  if (range) enemy.health = Math.max(range[0], Math.min(range[1], enemy.health));
}

/** A major item taken, by the server's pickup rules. */
export function applyPickup(enemy: { health: number; armor: number }, type: string, kind: string): void {
  if (type === "armor" && (kind === "ga" || kind === "ya" || kind === "ra" || kind === "shard")) {
    enemy.armor = Math.max(enemy.armor, armorAfterPickup(enemy.armor, kind as ArmorKind));
  } else if (type === "health" && (kind === "mega" || kind === "ultra" || kind === "large" || kind === "medium")) {
    enemy.health = Math.max(enemy.health, healthAfterPickup(enemy.health, kind as HealthKind));
  }
}

function entityOfPlayer(state: BotGameState, playerId: string): string | null {
  for (const player of state.players) if (player.playerId === playerId) return player.entityId;
  return null;
}

function readScore(state: BotGameState): ScoreRead {
  let own = 0;
  let deaths = 0;
  let bestOther = Number.NEGATIVE_INFINITY;
  for (const [playerId, row] of state.scores) {
    if (playerId === state.selfPlayerId) {
      own = row.score;
      deaths = row.deaths;
    } else bestOther = Math.max(bestOther, row.score);
  }
  return {
    own,
    deaths,
    bestOther: Number.isFinite(bestOther) ? bestOther : 0,
    timeRemaining: state.matchState.timeRemaining,
  };
}

export function cellOf(at: Vec3): string {
  return `${Math.round(at.x / 256) * 256},${Math.round(at.z / 256) * 256}`;
}
