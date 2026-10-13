/**
 * Team Deathmatch Gametype
 *
 * Team-based combat (Udon vs Soba).
 * - Auto-balancing on join
 * - 15 minute time limit
 * - 50 frag limit
 * - Shared item spawns like Deathmatch
 */

import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import type { PlayerId } from "@engine/server/ecs/types";
import { EntityType } from "@engine/server/ecs/types";
import type {
  AgentDirective,
  AgentDirectiveContext,
  ItemSpawnRules,
  MatchConfig,
  SpawnStrategyType,
  WeaponLoadout,
} from "@shared/server/gametype";
import { debugLog } from "../DebugLog";
import { BaseGametype, type GameResult } from "./BaseGametype";

/** Directives last this many ticks; re-issued every snapshot while they apply. */
const REGROUP_DIRECTIVE_TICKS = 250; // ~2s at 125Hz

/** A player further than this from their team's centre is out of position. */
const REGROUP_TRIGGER_DISTANCE = 1200;

/** How close to the team centre counts as regrouped. */
const REGROUP_ARRIVAL_RADIUS = 400;

export class TeamDeathmatch extends BaseGametype {
  readonly name = "Team Deathmatch";
  readonly maxPlayers = 16;
  readonly teamBased = true;

  // GametypeController passes its own MatchState around where needed,
  // but we can query it via controller if we needed to.
  // For now we rely on controller handling the state for us.

  // ========================================================================
  // Configuration
  // ========================================================================

  getMatchConfig(): MatchConfig {
    return {
      warmupTimeout: 120, // 2 minutes
      countdownDuration: 5, // get ready, then 3-2-1
      scoreLimit: 50, // frags to win
      timeLimit: 900, // 15 minutes
      postGameDuration: 15, // post-game screen duration
      respawnDelay: 3, // seconds min before respawn input accepted
      maxRespawnDelay: 6, // seconds auto-respawn deadline
      selfDamage: 1.0, // full self-damage
    };
  }

  getSpawnLoadout(): WeaponLoadout {
    return {
      weapons: ["blade"],
      ammo: { blade: 1 },
      health: 100,
      armor: 0,
    };
  }

  getItemSpawnRules(): ItemSpawnRules {
    return {
      spawnFromBsp: true,
      weaponRespawnTime: 30,
      ammoRespawnTime: 15,
      armorRespawnTime: 25,
      healthRespawnTime: 20,
      megaHealthRespawnTime: 60,
    };
  }

  getSpawnStrategy(): SpawnStrategyType {
    // 'team' strategy could be used here if implemented in SpawnPointStrategy.ts
    // For now fallback to farthest or random if team isn't supported yet
    return "furthest";
  }

  // ========================================================================
  // Events
  // ========================================================================

  onPlayerJoin(_playerId: PlayerId, _entityId: string, _state: WorldState, _teamId?: string): void {
    // Handled by controller loadout logic
  }

  // We don't use player/state here for now, so prefix with _ to satisfy linter
  onSpawn(_player: Entity, _state: WorldState): void {
    // Handled by controller loadout logic
  }

  onDeath(victim: Entity, killer: Entity | null, _state: WorldState): void {
    if (killer && killer.ownerId && killer.ownerId !== victim.ownerId) {
      debugLog("kills", () => `[TDM] Kill: player ${killer.ownerId} → player ${victim.ownerId}`);
    }
  }

  // ========================================================================
  // Queries
  // ========================================================================

  /**
   * Regroup order for players who have drifted away from their team.
   *
   * The proving case for the directive pipeline, and deliberately the simplest
   * useful one: it needs nothing but positions and teams, so it works on every
   * map with no authoring. A bot far from its team is told where the team is;
   * the bot still decides whether regrouping beats the Red Armor next to it,
   * which is exactly the arbitration this phase exists to enable.
   *
   * Pure: reads state, allocates a directive, mutates nothing.
   */
  getAgentDirectives(context: AgentDirectiveContext, state: WorldState): readonly AgentDirective[] {
    if (!context.alive || !context.teamId || context.teamId === "spectator") return [];

    // Team centre, excluding this player — otherwise a lone player is always
    // "at the centre" of their own position and never regroups.
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let mates = 0;
    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (entity.ownerId === undefined || entity.ownerId === context.playerId) continue;
      if (entity.health?.dead) continue;
      if (context.teamOf(entity.ownerId as number) !== context.teamId) continue;
      const pos = entity.transform?.position;
      if (!pos) continue;
      sumX += pos.x;
      sumY += pos.y;
      sumZ += pos.z;
      mates++;
    }
    if (mates === 0) return [];

    const centre = { x: sumX / mates, y: sumY / mates, z: sumZ / mates };
    const dx = centre.x - context.position.x;
    const dy = centre.y - context.position.y;
    const dz = centre.z - context.position.z;
    const separation = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (separation < REGROUP_TRIGGER_DISTANCE) return [];

    return [
      {
        // Stable per team, NOT per issue: the order is re-sent every snapshot
        // while it applies, and a changing id would break goal commitment.
        id: `tdm_regroup_${context.teamId}`,
        kind: "hold_area",
        target: { type: "position", position: centre, radius: REGROUP_ARRIVAL_RADIUS },
        // Modest: regrouping is a suggestion, not an order worth dying for.
        priority: 0.45,
        expiresAtTick: context.tick + REGROUP_DIRECTIVE_TICKS,
        interrupt: "enemy_visible",
      },
    ];
  }

  checkWinCondition(_state: WorldState): GameResult | null {
    // Handled by controller
    return null;
  }

  getScore(_playerId: PlayerId): number {
    return 0; // Handled by controller MatchState
  }
}
