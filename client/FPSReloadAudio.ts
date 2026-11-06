import { AudioManager } from "../../../engine/AudioManager";
import type { WeaponStateEvent } from "../../../engine/network/core/SnapshotEvent";
import { canonicalWeaponId, WEAPONS } from "../shared/entities/definitions/weapons/WeaponsTable";

export const RELOAD_SOUND_PATH = "sounds/weapons/reload.ogg";
// Match the shipped weapon-pickup cue's level; the reload sample has lower RMS.
const RELOAD_VOLUME = 1.6;

/** One cue per reload edge, shared by live play, spectators and recorded POVs. */
export class FPSReloadAudio {
  private readonly states = new Map<string, { weapon: string; reloading: boolean }>();

  observe(
    event: WeaponStateEvent,
    viewed: boolean,
    position?: { x: number; y: number; z: number },
    present = true,
  ): void {
    const weapon = canonicalWeaponId(event.currentWeapon);
    const previous = this.states.get(event.entityId);
    this.states.set(event.entityId, { weapon, reloading: event.reloading === true });
    if (
      !present ||
      event.reloading !== true ||
      WEAPONS[weapon]?.reloadModel !== "clip" ||
      (previous?.weapon === weapon && previous.reloading)
    )
      return;

    const audio = AudioManager.getInstance();
    if (viewed) audio.playSfx2D(RELOAD_SOUND_PATH, RELOAD_VOLUME, 2);
    else if (position) audio.playSfx3D(RELOAD_SOUND_PATH, position, { volume: RELOAD_VOLUME });
  }

  prune(entityIds: Iterable<string>): void {
    const alive = new Set(entityIds);
    for (const id of this.states.keys()) if (!alive.has(id)) this.states.delete(id);
  }

  reset(): void {
    this.states.clear();
  }
}
