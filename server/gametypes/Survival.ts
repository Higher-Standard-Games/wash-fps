/**
 * Survival — a campaign gametype: players against waves of weak robots, for a
 * set time, without a death.
 *
 * A team deathmatch underneath (players on one side, robots on the other).
 * The robots are ordinary bots the lobby seats; this gametype decides how
 * many of them are in play. Each wave keeps a number of robots alive, and a
 * robot that dies comes straight back while the wave wants it, so killing one
 * brings the next. Robots the wave does not want yet wait, dead, in the
 * respawn queue. A robot spawns with the health of the wave it spawns in (one
 * still alive from an earlier wave keeps its own) and its kit, the mission's
 * kits handed out in turn (a machine gun that aims, one that fires from the
 * hip only, a grenade launcher), and picks nothing up. Players spawn with the blade and a machine gun, arm
 * themselves from the map, and heal a point a second up to 100 (overheal's
 * decay in reverse). The first player death loses the match; lasting to
 * the time limit wins it (the match state, told the players' side, settles
 * both).
 */

import type { WorldState } from "@engine/server/core/WorldState";
import type { PlayerId } from "@engine/server/ecs/types";
import type { MatchConfig, WeaponLoadout } from "@shared/server/gametype";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "@shared/server/simulation/physics/constants";
import type { CampaignRobotKit, CampaignSurvivalRules, CampaignSurvivalWave } from "../../../../lobby/types";
import { HEALTH_MAX } from "../../shared/items/ItemGrants";
import type { GametypeTickContext } from "./BaseGametype";
import { TeamDeathmatch } from "./TeamDeathmatch";

/** A survival match when the campaign gives no rules: Survival on dm18 as first written. */
export const DEFAULT_SURVIVAL: CampaignSurvivalRules = {
  waves: [
    { robots: 4, health: 30 },
    { robots: 5, health: 40 },
    { robots: 6, health: 50 },
    { robots: 7, health: 50 },
  ],
  waveSeconds: 60,
  seconds: 300,
  robotKits: [{ weapons: ["machinegun"] }, { weapons: ["machinegun"], ads: false }, { weapons: ["glauncher"] }],
};

/** Ammunition a robot spawns with for each of its weapons. */
const ROBOT_AMMO = 200;

/** Machine gun rounds a player spawns with: a kit's worth. */
const PLAYER_MACHINEGUN_AMMO = 150;

/** A player spawns with the blade and a machine gun, and the map's items for the rest. */
const PLAYER_LOADOUT: WeaponLoadout = {
  weapons: ["blade", "machinegun"],
  ammo: { blade: 1, machinegun: PLAYER_MACHINEGUN_AMMO },
  health: 100,
  armor: 0,
};

export class Survival extends TeamDeathmatch {
  override readonly name = "Survival";
  private isPerson: (entityId: number) => boolean = () => false;
  private isBot: (playerId: PlayerId) => boolean = () => false;
  private clock: () => number = () => 0;
  /** Robots numbered as they first spawn, which hands out their kits in turn. */
  private readonly robotOrder = new Map<PlayerId, number>();

  constructor(private readonly rules: CampaignSurvivalRules = DEFAULT_SURVIVAL) {
    super();
  }

  override getMatchConfig(): MatchConfig {
    return {
      ...super.getMatchConfig(),
      // No frag limit: the clock is the goal
      scoreLimit: 0,
      timeLimit: this.rules.seconds,
      // A robot let back in comes back at once
      respawnDelay: 0.5,
      maxRespawnDelay: 1,
    };
  }

  override setPersonCheck(check: (entityId: number) => boolean): void {
    this.isPerson = check;
  }

  override setBotCheck(check: (playerId: PlayerId) => boolean): void {
    this.isBot = check;
  }

  override setMatchClock(clock: () => number): void {
    this.clock = clock;
  }

  override getSpawnLoadout(playerId?: PlayerId): WeaponLoadout {
    if (playerId === undefined || !this.isBot(playerId)) return PLAYER_LOADOUT;
    const kit = this.kitOf(playerId);
    return {
      weapons: [...kit.weapons],
      ammo: Object.fromEntries(kit.weapons.map((weapon) => [weapon, weapon === "blade" ? 1 : ROBOT_AMMO])),
      // The wave it spawns in decides its health
      health: this.wave(this.clock()).health,
      armor: 0,
      ...(kit.ads === false ? { adsDisabled: true } : {}),
    };
  }

  /** People heal a point a second up to full health, as overheal decays down to it. */
  override onTick(state: WorldState, context: GametypeTickContext): null {
    if ((context.tick as number) % TICK_RATE !== 0) return null;
    for (const player of state.players()) {
      if (!player.health || player.health.dead || player.health.health >= HEALTH_MAX || !this.isPerson(player.id))
        continue;
      const health = state.getEntityMut(player.id)?.health;
      if (health) health.health = Math.min(HEALTH_MAX, health.health + 1);
    }
    return null;
  }

  /** A robot's kit: the rules' kits handed out in turn, a robot keeping its own at every spawn. */
  private kitOf(playerId: PlayerId): CampaignRobotKit {
    // Numbered at its first spawn as a robot: a bot is known as one only just after it joins
    let order = this.robotOrder.get(playerId);
    if (order === undefined) {
      order = this.robotOrder.size;
      this.robotOrder.set(playerId, order);
    }
    return this.rules.robotKits[order % this.rules.robotKits.length];
  }

  /** Robots keep the weapons they spawned with: only people pick things up. */
  override mayPickUp(entityId: number): boolean {
    return this.isPerson(entityId);
  }

  /** The wave at this point of the match: how many robots it keeps alive, and their health. */
  wave(elapsedSeconds: number): CampaignSurvivalWave {
    const wave = Math.min(
      Math.floor(Math.max(0, elapsedSeconds) / this.rules.waveSeconds),
      this.rules.waves.length - 1,
    );
    return this.rules.waves[wave];
  }

  /** People always come back; a robot only while its wave has room. */
  override mayRespawn(entityId: number, state: WorldState, elapsedSeconds: number): boolean {
    if (this.isPerson(entityId)) return true;
    let alive = 0;
    for (const player of state.players()) {
      if (player.id !== entityId && !this.isPerson(player.id) && player.health && !player.health.dead) alive++;
    }
    return alive < this.wave(elapsedSeconds).robots;
  }
}
