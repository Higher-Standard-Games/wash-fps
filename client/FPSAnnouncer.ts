/**
 * FPSAnnouncer — the voice that calls the match, one line at a time.
 *
 * Every announcer line goes through here, so two never land on top of each
 * other. A line either speaks now (`say`) and holds the voice for a moment, or
 * waits its turn (`queue`) and is released when the voice is free, as Warsow's
 * immediate and queued announcer events.
 *
 * The match flow is the same in every mode but Search and Destroy, which calls
 * its rounds itself (`FPSBombAudio`, through this same voice):
 *
 *  - countdown: "get ready to fight" when there is time before the numbers,
 *    then 3, 2, 1 on the whole seconds;
 *  - the match goes live: "fight";
 *  - the lead: taken, tied or lost, yours or your team's, while the match is live;
 *  - overtime: "overtime" each time it is extended;
 *  - the match ends: "game over";
 *  - warmup: "please ready up" once a minute to a player who is not ready.
 *
 * Media: `sounds/announcer/*` from the shipped pk3s; most lines have two reads.
 */

import { AudioManager } from "../../../engine/AudioManager";
import { MatchPhase } from "./MatchStateManager";

/** How long a line holds the voice before the next may start, as Warsow. */
const VOICE_HOLD_MS = 1500;
/** Seconds between ready-up reminders in warmup. */
const READY_NAG_SECONDS = 60;
/** Time the countdown needs before "3" to fit "get ready to fight" in front. */
const GET_READY_LEAD_SECONDS = 1.5;

const COUNT = [
  null,
  "sounds/announcer/countdown/1_0",
  "sounds/announcer/countdown/2_0",
  "sounds/announcer/countdown/3_0",
] as const;
const GET_READY = "sounds/announcer/countdown/get_ready_to_fight0";
const FIGHT = "sounds/announcer/countdown/fight0";
const GAME_OVER = "sounds/announcer/postmatch/game_over0";
const OVERTIME = ["sounds/announcer/overtime/overtime.ogg", "sounds/announcer/overtime/overtime02.ogg"] as const;
const READY_UP = "sounds/announcer/pleasereadyup.ogg";

/** The lead lines and how many reads each has; the team's are the team's lead. */
const LEAD = {
  alone: { own: ["sounds/announcer/score/taken_lead0", 2], team: ["sounds/announcer/score/taken_lead0", 2] },
  tied: { own: ["sounds/announcer/score/tied_lead0", 2], team: ["sounds/announcer/score/team_tied_lead0", 3] },
  behind: { own: ["sounds/announcer/score/lost_lead0", 3], team: ["sounds/announcer/score/team_lost_lead0", 2] },
} as const;

/** One of a line's reads, `01` up to `0<reads>`. */
function read(stem: string, reads = 2): string {
  return `${stem}${1 + Math.floor(Math.random() * reads)}.ogg`;
}

const all = (stem: string, reads = 2) => Array.from({ length: reads }, (_, i) => `${stem}${i + 1}.ogg`);
const both = (stem: string) => all(stem);

/** Where a score stands against the others: ahead of all, level with the best, or behind it. */
export type Lead = "alone" | "tied" | "behind";

/** null when there is no one to lead. */
export function leadOf(scores: readonly number[], mine: number): Lead | null {
  if (scores.length < 2) return null;
  const best = Math.max(...scores);
  if (mine < best) return "behind";
  return scores.filter((score) => score === best).length > 1 ? "tied" : "alone";
}

export const FPS_ANNOUNCER_SOUND_PATHS = [
  ...both(COUNT[1]),
  ...both(COUNT[2]),
  ...both(COUNT[3]),
  ...both(GET_READY),
  ...both(FIGHT),
  ...both(GAME_OVER),
  ...OVERTIME,
  READY_UP,
  ...Object.values(LEAD).flatMap(({ own, team }) => [...all(own[0], own[1]), ...all(team[0], team[1])]),
] as const;

/** Predecode the announcer bank once the map's PK3 index is available. */
export async function preloadFPSAnnouncer(): Promise<void> {
  await AudioManager.getInstance().preloadSfx(FPS_ANNOUNCER_SOUND_PATHS);
}

/** What the match flow needs to know each frame. */
export interface MatchMoment {
  phase: MatchPhase;
  /** Seconds left in the phase: the countdown's, during the countdown. */
  timeRemaining: number;
  /** Overtime extensions so far. */
  overtime: number;
  /** Search and Destroy calls its own rounds. */
  roundsCalledByMode: boolean;
  /** The local player is in the match, not spectating. */
  playing: boolean;
  ready: boolean;
  /** Your standing, or your team's in a team mode; null with no one to lead. */
  lead: Lead | null;
  teamBased: boolean;
}

export class FPSAnnouncer {
  private readonly waiting: string[] = [];
  private heldUntil = 0;
  private lastPhase: MatchPhase | null = null;
  private lastCountSecond: number | null = null;
  private lastOvertime = 0;
  private warmupSeconds = 0;
  private lastLead: Lead | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Speak now, cutting in front of anything waiting. */
  say(path: string): void {
    AudioManager.getInstance().playSfx2D(path, 1.0, 2, "announcer");
    this.heldUntil = this.now() + VOICE_HOLD_MS;
  }

  /** Speak when the voice is free. */
  queue(path: string): void {
    this.waiting.push(path);
    this.release();
  }

  /** Forget everything waiting, as on leaving a match. */
  clear(): void {
    this.waiting.length = 0;
    this.heldUntil = 0;
    this.lastPhase = null;
    this.lastCountSecond = null;
    this.lastOvertime = 0;
    this.warmupSeconds = 0;
    this.lastLead = null;
  }

  /** Called every frame: releases queued lines, and calls the match. `dt` in seconds. */
  update(moment: MatchMoment, dt: number): void {
    this.callMatch(moment, dt);
    this.release();
  }

  private release(): void {
    if (this.waiting.length === 0 || this.now() < this.heldUntil) return;
    this.say(this.waiting.shift()!);
  }

  private callMatch(moment: MatchMoment, dt: number): void {
    const previous = this.lastPhase;
    const entered = moment.phase !== previous;
    this.lastPhase = moment.phase;
    // Joining a match already under way announces nothing that came before
    if (previous === null) this.lastOvertime = moment.overtime;

    if (moment.phase === MatchPhase.Warmup) {
      this.warmupSeconds = entered ? 0 : this.warmupSeconds + dt;
      if (moment.playing && !moment.ready && this.warmupSeconds >= READY_NAG_SECONDS) {
        this.warmupSeconds = 0;
        this.queue(READY_UP);
      }
      return;
    }

    if (moment.phase === MatchPhase.PostGame) {
      if (entered && previous !== null) this.queue(read(GAME_OVER));
      return;
    }

    if (moment.roundsCalledByMode) return;

    if (moment.phase === MatchPhase.Countdown) {
      if (entered) {
        this.lastCountSecond = null;
        if (moment.timeRemaining >= 3 + GET_READY_LEAD_SECONDS) this.say(read(GET_READY));
      }
      const second = Math.ceil(moment.timeRemaining);
      const stem = second !== this.lastCountSecond ? COUNT[second] : null;
      if (stem) this.say(read(stem));
      this.lastCountSecond = second;
      return;
    }

    if (moment.phase !== MatchPhase.Active) this.lastLead = null;

    if (moment.phase === MatchPhase.Active) {
      if (entered && previous === MatchPhase.Countdown) this.say(read(FIGHT));
      this.callLead(moment);
      if (moment.overtime > this.lastOvertime) {
        this.queue(OVERTIME[Math.random() < 0.5 ? 0 : 1]);
      }
      this.lastOvertime = moment.overtime;
    }
  }

  /**
   * The first standing seen is only noted, so the level start says nothing;
   * every change of standing after it is called.
   */
  private callLead(moment: MatchMoment): void {
    const lead = moment.playing ? moment.lead : null;
    const from = this.lastLead;
    this.lastLead = lead;
    if (!lead || !from || lead === from) return;
    const [stem, reads] = moment.teamBased ? LEAD[lead].team : LEAD[lead].own;
    this.queue(read(stem, reads));
  }
}
