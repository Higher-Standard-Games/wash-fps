/**
 * Deathmatch Gametype
 * Free-for-all deathmatch with Warsow-style rules and chosen kits:
 * - Furthest spawn selection
 * - Spawn with the blade and a chosen kit (Loadout.ts); a change applies at the
 *   next spawn
 * - Every BSP item spawns except weapons: the kit is the arsenal
 */

import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import type { PlayerId } from "@engine/server/ecs/types";
import type {
  ItemSpawnRules,
  LoadoutChoice,
  MatchConfig,
  SpawnStrategyType,
  WeaponLoadout,
} from "@shared/server/gametype";
import { WEAPON_PICKUP_CLASSNAMES } from "../../../../shared/bsp/PickupTable";
import { debugLog } from "../DebugLog";
import { BaseGametype, type GameResult } from "./BaseGametype";
import { PlayerLoadouts } from "./PlayerLoadouts";

export class Deathmatch extends BaseGametype {
  readonly name = "Deathmatch";
  readonly maxPlayers = 16;
  readonly teamBased = false;

  private scores: Map<PlayerId, number> = new Map();
  /** Kits: a change applies at the player's next spawn. Spawn armor stays Deathmatch's own (none). */
  private loadouts = new PlayerLoadouts("respawn", 0);

  // ========================================================================
  // Configuration
  // ========================================================================

  getMatchConfig(): MatchConfig {
    return {
      warmupTimeout: 120, // 2 minutes
      countdownDuration: 5, // get ready, then 3-2-1
      scoreLimit: 20, // frags to win
      timeLimit: 600, // 10 minutes
      postGameDuration: 15, // post-game screen duration
      respawnDelay: 3, // seconds min before respawn input accepted
      maxRespawnDelay: 6, // seconds auto-respawn deadline
      selfDamage: 1.0, // full self-damage (standard DM)
      loadouts: "respawn",
    };
  }

  getSpawnLoadout(playerId?: PlayerId): WeaponLoadout {
    return this.loadouts.spawnKit(playerId);
  }

  override setPlayerLoadout(playerId: PlayerId, choice: LoadoutChoice): boolean {
    this.loadouts.choose(playerId, choice);
    return true;
  }

  // No join gate (`hasChosenLoadout` stays true). The game client's picker
  // blocks the join until a kit is chosen; a client that never chooses (a
  // headless one, an older one) spawns with the default kit, which its next
  // spawn can correct. In a round mode a default would cost a whole round.

  override onPlayerLeave(playerId: PlayerId): void {
    this.loadouts.forget(playerId);
  }

  getItemSpawnRules(): ItemSpawnRules {
    return {
      spawnFromBsp: true,
      excludeClassnames: WEAPON_PICKUP_CLASSNAMES,
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

  // ========================================================================
  // Events
  // ========================================================================

  onPlayerJoin(_playerId: PlayerId, _entityId: string, _state: WorldState, _teamId?: string): void {
    // No special action required
  }

  onSpawn(_player: Entity, _state: WorldState): void {
    // Loadout is handled by GametypeController using getSpawnLoadout()
  }

  onDeath(victim: Entity, killer: Entity | null, _state: WorldState): void {
    // Score is tracked by MatchState.addScore() called from GametypeController
    // We just log here for debugging
    if (killer?.ownerId && killer.ownerId !== victim.ownerId) {
      debugLog("kills", () => `[Deathmatch] Kill: player ${killer.ownerId} → player ${victim.ownerId}`);
    }
  }

  // ========================================================================
  // Queries
  // ========================================================================

  checkWinCondition(_state: WorldState): GameResult | null {
    // Win condition is checked by GametypeController using MatchState scores
    // This is called by the controller which passes in its own scores
    return null;
  }

  getScore(playerId: PlayerId): number {
    return this.scores.get(playerId) || 0;
  }
}
