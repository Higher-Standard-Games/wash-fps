/**
 * Each player's chosen kit, for the modes that have kits (S&D, Amphi,
 * Deathmatch). One store, so the rules cannot drift between modes.
 *
 * A player's FIRST choice applies at once: they have no kit to re-kit and are
 * not playing yet, so waiting would only hand a joining player a default nobody
 * asked for. A later choice waits: for the next round in a round mode, so a lost
 * gunfight is not a free re-kit; for the player's next spawn in a respawning mode.
 */
import type { PlayerId } from "@engine/server/ecs/types";
import type { LoadoutChoice, LoadoutMode, WeaponLoadout } from "@shared/server/gametype";
import { buildLoadout, DEFAULT_LOADOUT } from "@shared/server/gametype";

export class PlayerLoadouts {
  private readonly active = new Map<PlayerId, LoadoutChoice>();
  private readonly pending = new Map<PlayerId, LoadoutChoice>();

  /** `spawnArmor`: the armor a kit spawns with (the round modes' 100, or a mode's own). */
  constructor(
    readonly mode: LoadoutMode,
    private readonly spawnArmor?: number,
  ) {}

  /** Remember a choice. Always accepted; when it applies depends on the mode. */
  choose(playerId: PlayerId, choice: LoadoutChoice): void {
    if (!this.active.has(playerId)) this.active.set(playerId, choice);
    this.pending.set(playerId, choice);
  }

  /** True once this player has chosen. Gates joining. */
  has(playerId: PlayerId): boolean {
    return this.active.has(playerId);
  }

  /** The kit in force for a player's spawn. In a respawning mode, a waiting choice takes effect here. */
  spawnKit(playerId: PlayerId | undefined): WeaponLoadout {
    if (playerId !== undefined && this.mode === "respawn") this.promote(playerId);
    const choice = (playerId !== undefined ? this.active.get(playerId) : undefined) ?? DEFAULT_LOADOUT;
    return buildLoadout(choice, this.spawnArmor);
  }

  /** A new round: every waiting choice takes effect. */
  startRound(): void {
    for (const [playerId, choice] of this.pending) this.active.set(playerId, choice);
    this.pending.clear();
  }

  /** The kit that will be in force at the next round or spawn. */
  next(playerId: PlayerId): LoadoutChoice {
    return this.pending.get(playerId) ?? this.active.get(playerId) ?? DEFAULT_LOADOUT;
  }

  forget(playerId: PlayerId): void {
    this.active.delete(playerId);
    this.pending.delete(playerId);
  }

  private promote(playerId: PlayerId): void {
    const choice = this.pending.get(playerId);
    if (!choice) return;
    this.active.set(playerId, choice);
    this.pending.delete(playerId);
  }
}
