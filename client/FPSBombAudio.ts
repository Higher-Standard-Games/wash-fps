/**
 * FPSBombAudio — the bomb's beep, and the announcer.
 *
 * Two cues with different jobs:
 *
 *  - **The beep** (`sounds/bomb/bombtimer.ogg`) is the CLOCK, and everyone
 *    hears it — both teams, anywhere on the map. It fires on the interval the
 *    server computes, one twelfth of the remaining fuse, so it accelerates
 *    smoothly toward detonation.
 *
 *    Deliberately 2D rather than positional. There is no fuse number on the
 *    HUD, so this is the only thing telling anyone how long is left, and a
 *    defender who rotated late must not be the one person who cannot hear it.
 *    Knowing the time is shared; knowing where the bomb is stays a matter of
 *    the site markers and going to look.
 *
 *  - **The announcer** is 2D and side-aware. Warsow ships separate offense and
 *    defense reads of every event, because "planted" is good news for one team
 *    and bad for the other, and a single line tells one of them nothing.
 *
 * Media: `sounds/bomb/*` and `sounds/announcer/bomb/*` from the shipped pk3s.
 */

import { AudioManager } from "../../../engine/AudioManager";
import type { BombObjectiveSnapshot } from "./MatchStateManager";

const BOMB_TIMER = "sounds/bomb/bombtimer.ogg";

/** Announcer lines, per side. Warsow authors both reads of each event. */
const ANNOUNCE = {
  taken: { offense: "sounds/announcer/bomb/offense/taken.ogg", defense: null },
  planted: {
    offense: "sounds/announcer/bomb/offense/planted.ogg",
    defense: "sounds/announcer/bomb/defense/planted.ogg",
  },
  defused: {
    offense: "sounds/announcer/bomb/offense/defused.ogg",
    defense: "sounds/announcer/bomb/defense/defused.ogg",
  },
} as const;

export const FPS_BOMB_SOUND_PATHS = [
  BOMB_TIMER,
  ANNOUNCE.taken.offense,
  ANNOUNCE.planted.offense,
  ANNOUNCE.planted.defense,
  ANNOUNCE.defused.offense,
  ANNOUNCE.defused.defense,
] as const;

/**
 * The beep is not attenuated at all.
 *
 * It is the only clock in the mode. Falling off with distance would mean the
 * player furthest from the bomb — usually the one deciding whether a retake is
 * still possible — is the one told least about it.
 */
const BEEP_VOLUME = 0.75;

/** Predecode the bomb bank once the map's PK3 index is available. */
export async function preloadFPSBombAudio(): Promise<void> {
  await AudioManager.getInstance().preloadSfx(FPS_BOMB_SOUND_PATHS);
}

export class FPSBombAudio {
  /** Seconds until the next beep. */
  private nextBeep = 0;
  /** Phase last seen, for edge-detecting the announcements. */
  private lastPhase: string | null = null;

  /**
   * Called every frame with the current objective. `dt` is seconds.
   *
   * Phase edges are detected here rather than delivered as wire events: the
   * bomb's phase is authoritative and only moves forward within a round, so a
   * client comparing frames reaches the same conclusion the server would, with
   * nothing extra on the wire.
   */
  update(bomb: BombObjectiveSnapshot | null, dt: number, attacking: boolean): void {
    if (!bomb) {
      this.reset();
      return;
    }

    if (bomb.phase !== this.lastPhase) {
      this.announce(this.lastPhase, bomb.phase, attacking);
      this.lastPhase = bomb.phase;
      // A fresh arm should beep at once, not after one full interval of silence.
      if (bomb.phase === "armed") this.nextBeep = 0;
    }

    if (bomb.phase !== "armed" || bomb.beepInterval === null) return;

    this.nextBeep -= dt;
    if (this.nextBeep > 0) return;
    this.nextBeep = bomb.beepInterval;
    AudioManager.getInstance().playSfx2D(BOMB_TIMER, BEEP_VOLUME, 2);
  }

  /** Announce a phase change to the local player, in their side's voice. */
  private announce(from: string | null, to: string, attacking: boolean): void {
    // No line on the first frame of a round — `from === null` means we have
    // only just started watching, not that anything happened.
    if (from === null) return;

    const side = attacking ? "offense" : "defense";
    let path: string | null = null;
    if (to === "carried" && from === "dropped") path = ANNOUNCE.taken[side];
    else if (to === "armed") path = ANNOUNCE.planted[side];
    else if (to === "defused") path = ANNOUNCE.defused[side];

    if (path) AudioManager.getInstance().playSfx2D(path, 1.0, 3);
  }

  /** Round over, or a mode without a bomb. */
  reset(): void {
    this.nextBeep = 0;
    this.lastPhase = null;
  }
}
