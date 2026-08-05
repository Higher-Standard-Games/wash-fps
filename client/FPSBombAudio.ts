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
import { DEFAULT_BOMB_RULES } from "../../../shared/server/gametype/BombModel";
import { DEFAULT_PHYSICS_TICK_RATE } from "../../../shared/server/simulation/physics/constants";
import { type BombObjectiveSnapshot, MatchPhase } from "./MatchStateManager";

const BOMB_TIMER = "sounds/bomb/bombtimer.ogg";

/** Announcer lines, per side. Warsow authors both reads of each event. */
const ANNOUNCE = {
  taken: { offense: "sounds/announcer/bomb/offense/taken.ogg", defense: null },
  /** Placed at a site, arm meter filling — the bomb is down but not yet live. */
  planted: {
    offense: "sounds/announcer/bomb/offense/planted.ogg",
    defense: "sounds/announcer/bomb/defense/planted.ogg",
  },
  /**
   * Armed and counting down. A separate moment from being placed, and the two
   * ask different things of you: "it is down" versus "it is live, go".
   */
  armed: {
    offense: "sounds/announcer/bomb/offense/inplace.ogg",
    defense: "sounds/announcer/bomb/defense/defuse.ogg",
  },
  defused: {
    offense: "sounds/announcer/bomb/offense/defused.ogg",
    defense: "sounds/announcer/bomb/defense/defused.ogg",
  },
} as const;

/**
 * Round transitions — the freeze, and the go.
 *
 * Warsow authors these too, and their absence was the loudest thing about a
 * round: the freeze arrived in silence and the round went live in silence, so
 * the only way to know either had happened was to be watching the HUD at that
 * moment. `get_ready_to_fight` and `fight` are the generic countdown reads that
 * every Warsow gametype uses; the bomb set adds a per-side line naming the job
 * you have this round, which is the part a round mode actually needs.
 */
const ROUND = {
  freeze: "sounds/announcer/countdown/get_ready_to_fight01.ogg",
  go: "sounds/announcer/countdown/fight01.ogg",
  start: {
    offense: "sounds/announcer/bomb/offense/start.ogg",
    defense: "sounds/announcer/bomb/defense/start.ogg",
  },
  /** Spoken 3-2-1 over the end of the freeze. Index 0 is unused. */
  count: [
    null,
    "sounds/announcer/countdown/1_01.ogg",
    "sounds/announcer/countdown/2_01.ogg",
    "sounds/announcer/countdown/3_01.ogg",
  ],
} as const;

/**
 * The "you are nearly out of time" line, per side.
 *
 * Both sides get warned the same distance from the moment their job stops being
 * possible — which is a different moment for each. An attacker runs out when
 * there is no longer time to finish an arm; a defender runs out when there is no
 * longer time to finish a defuse. Warning at a fixed clock reading instead would
 * be early for one and useless for the other.
 */
const LAST_CALL = {
  offense: "sounds/announcer/bomb/offense/lastcall.ogg",
  defense: "sounds/announcer/bomb/defense/defuse.ogg",
} as const;

/** How much warning the last call gives, before the job becomes impossible. */
const LAST_CALL_LEAD_SECONDS = 5;

/** Arm and defuse durations in seconds, from the rules the server runs. */
const ARM_SECONDS = DEFAULT_BOMB_RULES.armTicks / DEFAULT_PHYSICS_TICK_RATE;
const DEFUSE_SECONDS = DEFAULT_BOMB_RULES.defuseTicks / DEFAULT_PHYSICS_TICK_RATE;

export const FPS_BOMB_SOUND_PATHS = [
  BOMB_TIMER,
  ANNOUNCE.taken.offense,
  ANNOUNCE.planted.offense,
  ANNOUNCE.planted.defense,
  ANNOUNCE.armed.offense,
  ANNOUNCE.armed.defense,
  ANNOUNCE.defused.offense,
  ANNOUNCE.defused.defense,
  ROUND.freeze,
  ROUND.go,
  ROUND.start.offense,
  ROUND.start.defense,
  ROUND.count[1],
  ROUND.count[2],
  ROUND.count[3],
  LAST_CALL.offense,
  LAST_CALL.defense,
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
  /** The last call is once per round, whichever side it went to. */
  private lastCallDone = false;
  /** Whole second last spoken in the freeze countdown. */
  private lastCountSecond: number | null = null;

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
    else if (to === "planted") path = ANNOUNCE.planted[side];
    else if (to === "armed") path = ANNOUNCE.armed[side];
    else if (to === "defused") path = ANNOUNCE.defused[side];

    if (path) AudioManager.getInstance().playSfx2D(path, 1.0, 3);
  }

  /**
   * "You are nearly out of time", once per round, to whichever side is running
   * out of it.
   *
   * The deadline is not the clock hitting zero — it is the last moment the job
   * could still be STARTED and finished. An attacker with three seconds left
   * cannot complete a four-second arm, so their round is already over; a
   * defender needs a full defuse inside the remaining fuse. Warning a fixed
   * number of seconds before each of those is the same warning for both sides,
   * even though it lands at different readings on different clocks.
   */
  private lastCall(bomb: BombObjectiveSnapshot, timeRemaining: number, attacking: boolean): void {
    if (this.lastCallDone) return;

    const armed = bomb.phase === "armed";
    let due = false;
    if (attacking) {
      // Only while the bomb is still theirs to plant — once it is armed the
      // attack has done its job and the clock stops mattering to them.
      due = !armed && timeRemaining > 0 && timeRemaining <= ARM_SECONDS + LAST_CALL_LEAD_SECONDS;
    } else if (armed && bomb.fuse !== null) {
      due = bomb.fuse <= DEFUSE_SECONDS + LAST_CALL_LEAD_SECONDS;
    }
    if (!due) return;

    this.lastCallDone = true;
    AudioManager.getInstance().playSfx2D(attacking ? LAST_CALL.offense : LAST_CALL.defense, 1.0, 3);
  }

  /**
   * Spoken 3-2-1 over the end of the freeze.
   *
   * Keyed off the whole second remaining, so it fires once per number however
   * many frames sit inside that second.
   */
  private countdown(timeRemaining: number): void {
    const second = Math.ceil(timeRemaining);
    if (second === this.lastCountSecond) return;
    this.lastCountSecond = second;

    const path = ROUND.count[second];
    if (path) AudioManager.getInstance().playSfx2D(path, 1.0, 3);
  }

  /**
   * Call on a match phase change, so a round announces its own start.
   *
   * Separate from `update` because these are MATCH phases, not bomb phases —
   * the freeze happens while the bomb is sitting untouched at the attackers'
   * spawn, and nothing about the bomb changes to mark it.
   *
   * The per-side line rides on the freeze rather than the go: it tells you what
   * your job is this round, and the freeze is the ten seconds you have to act
   * on that before anyone can move.
   */
  onMatchPhase(phase: MatchPhase, previous: MatchPhase | null, attacking: boolean): void {
    if (previous === null || phase === previous) return;

    // A new round is a clean slate for the once-per-round lines.
    this.lastCallDone = false;
    this.lastCountSecond = null;

    const audio = AudioManager.getInstance();
    if (phase === MatchPhase.Countdown) {
      audio.playSfx2D(ROUND.freeze, 1.0, 3);
      audio.playSfx2D(attacking ? ROUND.start.offense : ROUND.start.defense, 1.0, 3);
    } else if (phase === MatchPhase.Active) {
      audio.playSfx2D(ROUND.go, 1.0, 3);
    }
  }

  /**
   * Per-frame round audio: the spoken 3-2-1, and the last call.
   *
   * Takes the match clock rather than reading it, so the side it announces for
   * and the clock it announces against come from the same frame — the two used
   * to be resolved in different places, which is how you end up telling someone
   * the wrong job is running out.
   */
  updateRound(phase: MatchPhase, timeRemaining: number, bomb: BombObjectiveSnapshot | null, attacking: boolean): void {
    if (phase === MatchPhase.Countdown) {
      this.countdown(timeRemaining);
      return;
    }
    if (phase === MatchPhase.Active && bomb) this.lastCall(bomb, timeRemaining, attacking);
  }

  /** Round over, or a mode without a bomb. */
  reset(): void {
    this.nextBeep = 0;
    this.lastPhase = null;
    this.lastCallDone = false;
    this.lastCountSecond = null;
  }
}
