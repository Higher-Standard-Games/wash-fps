/**
 * Each player's selected spawn kit. WeaponSystem owns the live inventory;
 * changing this selection only affects the kit granted at the next spawn.
 */
import type { PlayerId } from "@engine/server/ecs/types";
import type { LoadoutChoice, WeaponLoadout } from "@shared/server/gametype";
import { buildLoadout, DEFAULT_LOADOUT } from "@shared/server/gametype";

export class PlayerLoadouts {
  private readonly choices = new Map<PlayerId, LoadoutChoice>();

  /** `spawnArmor`: the armor a kit spawns with (the round modes' 100, or a mode's own). */
  constructor(private readonly spawnArmor?: number) {}

  /** Remember the choice to grant at the player's next spawn. */
  choose(playerId: PlayerId, choice: LoadoutChoice): void {
    this.choices.set(playerId, choice);
  }

  /** True once this player has chosen. Gates joining. */
  has(playerId: PlayerId): boolean {
    return this.choices.has(playerId);
  }

  /** Build the selected kit at a spawn boundary. */
  spawnKit(playerId: PlayerId | undefined): WeaponLoadout {
    const choice = (playerId !== undefined ? this.choices.get(playerId) : undefined) ?? DEFAULT_LOADOUT;
    return buildLoadout(choice, this.spawnArmor);
  }

  /** The selection shown when reviewing the next spawn kit. */
  next(playerId: PlayerId): LoadoutChoice {
    return this.choices.get(playerId) ?? DEFAULT_LOADOUT;
  }

  forget(playerId: PlayerId): void {
    this.choices.delete(playerId);
  }
}
