/**
 * Amphi: best-of-three 1v1 deathmatch. Each three-minute round starts with a
 * chosen kit, allows normal player/item respawns, and awards the round to the
 * player with more frags. Ties extend the round in one-minute increments.
 */
import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import type { PlayerId } from "@engine/server/ecs/types";
import type {
  ItemSpawnRules,
  LoadoutChoice,
  MatchConfig,
  SpawnStrategyType,
  TeamId,
  WeaponLoadout,
} from "@shared/server/gametype";
import { MatchPhase } from "@shared/server/gametype";
import { WEAPON_PICKUP_CLASSNAMES } from "../../shared/bsp/PickupTable";
import { BaseGametype, type GameResult, type GametypeTickContext, type RoundOutcome } from "./BaseGametype";
import { PlayerLoadouts } from "./PlayerLoadouts";

export class Amphi extends BaseGametype {
  readonly name = "Amphi";
  readonly maxPlayers = 2;
  readonly teamBased = true; // One player per side; the round score uses team scores.

  /** Kits: a change waits for the next round. */
  private loadouts = new PlayerLoadouts("round");
  private playerTeams = new Map<PlayerId, TeamId>();
  private roundFrags = new Map<TeamId, number>();
  private roundLive = false;

  getMatchConfig(): MatchConfig {
    return {
      warmupTimeout: 120,
      countdownDuration: 5,
      scoreLimit: 2,
      timeLimit: 180,
      postGameDuration: 15,
      respawnDelay: 2,
      maxRespawnDelay: 4,
      selfDamage: 1,
      roundBased: true,
      loadouts: "round",
      roundRespawns: true,
      resetScoresEachRound: true,
      maxRounds: 3,
      roundOvertimeOnDraw: true,
      roundOvertimeDuration: 60,
      roundEndDuration: 4,
      leadRequired: 1,
    };
  }

  getSpawnLoadout(playerId?: PlayerId): WeaponLoadout {
    return this.loadouts.spawnKit(playerId);
  }

  override setPlayerLoadout(playerId: PlayerId, choice: LoadoutChoice): boolean {
    // The first choice arms the player's first spawn; later choices wait for
    // the next round so a kit cannot be changed in the middle of a fight.
    this.loadouts.choose(playerId, choice);
    return true;
  }

  override hasChosenLoadout(playerId: PlayerId): boolean {
    return this.loadouts.has(playerId);
  }

  override onPlayerLeave(playerId: PlayerId): void {
    this.loadouts.forget(playerId);
    this.playerTeams.delete(playerId);
  }

  override onRoundStart(_state: WorldState, _context: GametypeTickContext): void {
    this.loadouts.startRound();
    this.roundFrags.clear();
    this.roundLive = false;
  }

  getItemSpawnRules(): ItemSpawnRules {
    return {
      spawnFromBsp: true,
      respawnMode: "timed",
      // The kit is the arsenal: no map weapons (Loadout.ts)
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

  onPlayerJoin(playerId: PlayerId, _entityId: string, _state: WorldState, teamId?: string): void {
    if (teamId === "udon" || teamId === "soba") this.playerTeams.set(playerId, teamId);
    else this.playerTeams.delete(playerId);
  }
  onSpawn(_player: Entity, _state: WorldState): void {}
  override onMatchPhaseChange(phase: MatchPhase): void {
    this.roundLive = phase === MatchPhase.Active;
  }

  onDeath(victim: Entity, killer: Entity | null, _state: WorldState): void {
    if (!this.roundLive || victim.ownerId === undefined || !killer || killer.ownerId === undefined) return;
    if (killer.ownerId === victim.ownerId) {
      const team = this.playerTeams.get(victim.ownerId);
      if (team) this.roundFrags.set(team, (this.roundFrags.get(team) ?? 0) - 1);
      return;
    }
    const killerTeam = this.playerTeams.get(killer.ownerId);
    const victimTeam = this.playerTeams.get(victim.ownerId);
    if (killerTeam && victimTeam && killerTeam !== victimTeam) {
      this.roundFrags.set(killerTeam, (this.roundFrags.get(killerTeam) ?? 0) + 1);
    }
  }

  override onRoundTimeExpired(_state: WorldState): RoundOutcome | null {
    const udon = this.roundFrags.get("udon") ?? 0;
    const soba = this.roundFrags.get("soba") ?? 0;
    if (udon === soba) return null;
    this.roundLive = false;
    const winner = udon > soba ? "udon" : "soba";
    return { winner, reason: "round time expired", resultKey: "timeout" };
  }

  checkWinCondition(_state: WorldState): GameResult | null {
    return null; // MatchState owns first-to-two round scoring.
  }

  getScore(_playerId: PlayerId): number {
    return 0; // MatchState holds the round score.
  }
}
