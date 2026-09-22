/**
 * Amphi: a compact 1v1 arena match, first to three rounds.
 * Each three-minute round starts with a chosen kit. Map pickups return at the
 * next round, so controlling a tiny arena still matters after the spawn.
 * Elimination decides a round immediately; at time, remaining health plus
 * armor decides it, with an exact tie recorded as a drawn round.
 */
import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import type { PlayerId } from "@engine/server/ecs/types";
import { EntityType } from "@engine/server/ecs/types";
import type {
  ItemSpawnRules,
  LoadoutChoice,
  MatchConfig,
  SpawnStrategyType,
  TeamId,
  WeaponLoadout,
} from "@shared/server/gametype";
import { buildLoadout, DEFAULT_LOADOUT } from "@shared/server/gametype";
import { BaseGametype, type GameResult, type GametypeTickContext, type RoundOutcome } from "./BaseGametype";

export class Amphi extends BaseGametype {
  readonly name = "Amphi";
  readonly maxPlayers = 2;
  readonly teamBased = true; // One player per side; the round score uses team scores.

  private activeLoadouts = new Map<PlayerId, LoadoutChoice>();
  private pendingLoadouts = new Map<PlayerId, LoadoutChoice>();
  private seenTeams = new Set<TeamId>();
  private remaining = new Map<TeamId, number>();

  getMatchConfig(): MatchConfig {
    return {
      warmupTimeout: 120,
      countdownDuration: 5,
      scoreLimit: 3,
      timeLimit: 180,
      postGameDuration: 15,
      respawnDelay: 2,
      maxRespawnDelay: 4,
      selfDamage: 1,
      roundBased: true,
      roundEndDuration: 4,
      leadRequired: 1,
    };
  }

  getSpawnLoadout(playerId?: PlayerId): WeaponLoadout {
    const choice = (playerId !== undefined ? this.activeLoadouts.get(playerId) : undefined) ?? DEFAULT_LOADOUT;
    return buildLoadout(choice);
  }

  setPlayerLoadout(playerId: PlayerId, choice: LoadoutChoice): boolean {
    // The first choice arms the player's first spawn; later choices wait for
    // the next round so a kit cannot be changed in the middle of a fight.
    if (!this.activeLoadouts.has(playerId)) this.activeLoadouts.set(playerId, choice);
    this.pendingLoadouts.set(playerId, choice);
    return true;
  }

  hasChosenLoadout(playerId: PlayerId): boolean {
    return this.activeLoadouts.has(playerId);
  }

  onPlayerLeave(playerId: PlayerId): void {
    this.activeLoadouts.delete(playerId);
    this.pendingLoadouts.delete(playerId);
  }

  onRoundStart(_state: WorldState, _context: GametypeTickContext): void {
    for (const [playerId, choice] of this.pendingLoadouts) this.activeLoadouts.set(playerId, choice);
    this.pendingLoadouts.clear();
    this.seenTeams.clear();
    this.remaining.clear();
  }

  getItemSpawnRules(): ItemSpawnRules {
    return {
      spawnFromBsp: true,
      respawnMode: "round",
      weaponRespawnTime: 30,
      ammoRespawnTime: 15,
      armorRespawnTime: 25,
      healthRespawnTime: 20,
      megaHealthRespawnTime: 60,
    };
  }

  getSpawnStrategy(): SpawnStrategyType {
    return "furthest";
  }

  onPlayerJoin(_playerId: PlayerId, _entityId: string, _state: WorldState, _teamId?: string): void {}
  onSpawn(_player: Entity, _state: WorldState): void {}
  onDeath(_victim: Entity, _killer: Entity | null, _state: WorldState): void {}

  onTick(state: WorldState, context: GametypeTickContext): RoundOutcome | null {
    if (!context.live) return null;
    const alive = new Map<TeamId, number>([
      ["udon", 0],
      ["soba", 0],
    ]);
    this.remaining.clear();
    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (entity.ownerId === undefined) continue;
      const team = context.teamOf(entity.ownerId);
      if (team !== "udon" && team !== "soba") continue;
      this.seenTeams.add(team);
      if (!entity.health || entity.health.dead) continue;
      alive.set(team, (alive.get(team) ?? 0) + 1);
      this.remaining.set(team, Math.max(0, entity.health.health) + Math.max(0, entity.health.armor));
    }

    // A player still loading the game must not lose a round before appearing.
    if (!this.seenTeams.has("udon") || !this.seenTeams.has("soba")) return null;
    const udonAlive = alive.get("udon") ?? 0;
    const sobaAlive = alive.get("soba") ?? 0;
    if (udonAlive === 0 && sobaAlive === 0) {
      return { winner: null, reason: "both players eliminated", resultKey: "eliminated" };
    }
    if (udonAlive === sobaAlive) return null;
    return {
      winner: udonAlive > sobaAlive ? "udon" : "soba",
      reason: "opponent eliminated",
      resultKey: "eliminated",
    };
  }

  onRoundTimeExpired(_state: WorldState): RoundOutcome {
    const udon = this.remaining.get("udon") ?? 0;
    const soba = this.remaining.get("soba") ?? 0;
    const winner = udon === soba ? null : udon > soba ? "udon" : "soba";
    return { winner, reason: "round time expired", resultKey: "timeout" };
  }

  checkWinCondition(_state: WorldState): GameResult | null {
    return null; // MatchState owns first-to-three scoring.
  }

  getScore(_playerId: PlayerId): number {
    return 0; // MatchState holds the round score.
  }
}
