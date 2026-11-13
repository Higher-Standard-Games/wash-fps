/**
 * MotionStats — how one player moves and looks, measured the same way for a
 * person and for a bot.
 *
 * Fed one sample per demo frame (`bot:demo-motion`), so a person in a recorded
 * match and a bot in a headless one are measured by the same code at the same
 * rate. Nothing here knows about brain states: "out of a fight" is "has not
 * pressed fire for a second", which a demo can tell for anyone.
 *
 * Measures:
 * - alive time standing still, sliding and airborne;
 * - out of a fight and running: speed, airborne share, and the gap from the
 *   hull to the nearest wall (when the caller supplies one);
 * - view out of a fight: turn rate and reversals on windows of at least 45 ms;
 * - flicks: turns faster than 300°/s, their size, and how many end in a
 *   correction the other way within 200 ms (an overshoot);
 * - jumps: take-offs per minute running, and how many leave the ground again
 *   within 0.25 s of landing (a hop chain);
 * - view pitch while running out of a fight;
 * - health and armor picked up, and deaths.
 *
 * Pure: the caller decides what a sample is and supplies clearance.
 */

export interface MotionSample {
  /** Seconds. */
  t: number;
  dead: boolean;
  /** View, radians. */
  yaw: number;
  pitch: number;
  /** Fire or alt fire held during the interval this sample covers. */
  firing: boolean;
  /** Horizontal speed, units/s. */
  speed: number;
  /** Direction of horizontal movement, radians, as yaw. */
  heading: number;
  grounded: boolean;
  sliding: boolean;
  health: number;
  armor: number;
  /** Gap from the hull to the nearest wall, NaN when not measured. */
  clearance: number;
}

const DEG = 180 / Math.PI;
/** Slower than this counts as standing still, units/s. */
export const STILL_SPEED = 80;
/** Faster than this counts as running, units/s. */
export const RUNNING_SPEED = 150;
/** Out of a fight: no fire for this long, seconds. */
export const CALM_AFTER_FIRE = 1;
/** Shortest window the view's turn rate is measured over, seconds. */
const TURN_WINDOW = 0.045;
/** Turning slower than this does not count as turning, rad/s. */
const TURNING = 60 / DEG;
/** A turn faster than this is a flick, rad/s. */
const FLICK_SPEED = 300 / DEG;
/** A correction the other way within this long after a flick is an overshoot, seconds. */
const OVERSHOOT_WINDOW = 0.2;
/** A correction has to turn at least this fast, rad/s. */
const CORRECTION_SPEED = 45 / DEG;
/** The view this far off the movement direction is looking elsewhere, rad. */
const VIEW_OFF_HEADING = 20 / DEG;
/** Leaving the ground within this long of landing chains the hops, seconds. */
const CHAIN_WINDOW = 0.25;
/** A sample gap this long means the player was dead or gone in between, seconds. */
const GAP = 1;

export function wrap(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export interface MotionTotals {
  alive: number;
  still: number;
  sliding: number;
  airborne: number;
  /** Out of a fight, running. */
  runSpeeds: number[];
  runAirborne: number;
  runCount: number;
  clearances: number[];
  runPitches: number[];
  /** View out of a fight. */
  calmTime: number;
  calmTurn: number;
  /** Out of a fight and running: how far the movement direction turned, and over how long. */
  headingTurn: number;
  headingTime: number;
  /** Running out of a fight: samples with the view more than 20° off the movement direction. */
  viewOffHeading: number;
  reversals: number;
  flicks: number;
  flickSizes: number[];
  overshoots: number;
  takeoffs: number;
  chainedTakeoffs: number;
  /** Running time, for take-offs per running minute. */
  runTime: number;
  gained: number;
  deaths: number;
}

export function emptyTotals(): MotionTotals {
  return {
    alive: 0,
    still: 0,
    sliding: 0,
    airborne: 0,
    runSpeeds: [],
    runAirborne: 0,
    runCount: 0,
    clearances: [],
    runPitches: [],
    calmTime: 0,
    calmTurn: 0,
    headingTurn: 0,
    headingTime: 0,
    viewOffHeading: 0,
    reversals: 0,
    flicks: 0,
    flickSizes: [],
    overshoots: 0,
    takeoffs: 0,
    chainedTakeoffs: 0,
    runTime: 0,
    gained: 0,
    deaths: 0,
  };
}

/** Add one player's samples, in time order, to `totals`. */
export function accumulateMotion(samples: readonly MotionSample[], totals: MotionTotals): void {
  let lastFire = Number.NEGATIVE_INFINITY;
  let landedAt = Number.NEGATIVE_INFINITY;
  let lastSign = 0;
  let windowStart = 0;
  /** Flick in progress: its direction, start view and when it ended. */
  let flick: { sign: number; from: number; to: number; endedAt: number; corrected: boolean } | null = null;

  const closeFlick = () => {
    if (!flick) return;
    totals.flicks++;
    totals.flickSizes.push(Math.abs(wrap(flick.to - flick.from)) * DEG);
    if (flick.corrected) totals.overshoots++;
    flick = null;
  };

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (b.firing) lastFire = b.t;
    const dt = b.t - a.t;
    if (a.dead || b.dead || dt <= 0 || dt > GAP) {
      if (!a.dead && b.dead) totals.deaths++;
      lastSign = 0;
      windowStart = i;
      closeFlick();
      continue;
    }
    totals.alive += dt;
    totals.gained += Math.max(0, b.health - a.health) + Math.max(0, b.armor - a.armor);
    if (b.speed < STILL_SPEED) totals.still += dt;
    if (b.sliding) totals.sliding += dt;
    if (!b.grounded) totals.airborne += dt;

    const calm = b.t - lastFire > CALM_AFTER_FIRE;
    const running = calm && b.speed > RUNNING_SPEED;
    if (running) {
      totals.runTime += dt;
      totals.runCount++;
      totals.runSpeeds.push(b.speed);
      totals.runPitches.push(b.pitch * DEG);
      if (!b.grounded) totals.runAirborne++;
      if (Math.abs(wrap(b.yaw - b.heading)) > VIEW_OFF_HEADING) totals.viewOffHeading++;
      if (a.speed > RUNNING_SPEED) {
        totals.headingTurn += Math.abs(wrap(b.heading - a.heading));
        totals.headingTime += dt;
      }
      if (!Number.isNaN(b.clearance)) totals.clearances.push(b.clearance);
    }

    // Jumps: a take-off is leaving the ground while not sliding off a ledge into a fall.
    if (!a.grounded && b.grounded) landedAt = b.t;
    if (a.grounded && !b.grounded && b.speed > RUNNING_SPEED) {
      totals.takeoffs++;
      if (b.t - landedAt <= CHAIN_WINDOW) totals.chainedTakeoffs++;
    }

    // View: turn rate over a window of at least TURN_WINDOW.
    const w = samples[windowStart];
    const span = b.t - w.t;
    if (span < TURN_WINDOW) continue;
    windowStart = i;
    if (!calm) {
      lastSign = 0;
      closeFlick();
      continue;
    }
    const turned = wrap(b.yaw - w.yaw);
    const rate = turned / span;
    totals.calmTime += span;
    totals.calmTurn += Math.abs(turned);
    const sign = Math.abs(rate) > TURNING ? Math.sign(rate) : 0;
    if (sign && lastSign && sign !== lastSign) totals.reversals++;
    if (sign) lastSign = sign;

    if (Math.abs(rate) > FLICK_SPEED) {
      if (flick && flick.sign === Math.sign(rate) && !flick.corrected) {
        flick.to = b.yaw;
        flick.endedAt = b.t;
      } else {
        closeFlick();
        flick = { sign: Math.sign(rate), from: w.yaw, to: b.yaw, endedAt: b.t, corrected: false };
      }
    } else if (flick) {
      if (b.t - flick.endedAt > OVERSHOOT_WINDOW) closeFlick();
      else if (Math.sign(rate) === -flick.sign && Math.abs(rate) > CORRECTION_SPEED) flick.corrected = true;
    }
  }
  closeFlick();
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

/** One line per measure, for a table of people against bots. */
export function motionRows(t: MotionTotals): [string, string][] {
  const pct = (part: number, whole: number) => (whole > 0 ? `${((100 * part) / whole).toFixed(0)}%` : "-");
  const per = (count: number, seconds: number) => (seconds > 0 ? ((count / seconds) * 60).toFixed(1) : "-");
  const num = (v: number, digits = 0) => (Number.isNaN(v) ? "-" : v.toFixed(digits));
  const within = (limit: number) => pct(t.clearances.filter((c) => c < limit).length, t.clearances.length);
  const fast = t.runSpeeds.filter((s) => s > 450).length;
  return [
    ["alive minutes", num(t.alive / 60, 1)],
    ["still", pct(t.still, t.alive)],
    ["sliding", pct(t.sliding, t.alive)],
    ["airborne", pct(t.airborne, t.alive)],
    ["running speed (median u/s)", num(median(t.runSpeeds))],
    ["running over 450 u/s", pct(fast, t.runSpeeds.length)],
    ["running airborne", pct(t.runAirborne, t.runCount)],
    ["wall gap running (median u)", num(median(t.clearances))],
    ["running within 24 u of a wall", within(24)],
    ["running within 8 u of a wall", within(8)],
    ["pitch running (median °)", num(median(t.runPitches), 1)],
    ["turning out of a fight (°/s)", t.calmTime > 0 ? num((t.calmTurn * DEG) / t.calmTime) : "-"],
    ["movement turning, running (°/s)", t.headingTime > 0 ? num((t.headingTurn * DEG) / t.headingTime) : "-"],
    ["view over 20° off movement, running", pct(t.viewOffHeading, t.runCount)],
    ["turn reversals per minute", per(t.reversals, t.calmTime)],
    ["flicks per minute", per(t.flicks, t.calmTime)],
    ["flick size (median °)", num(median(t.flickSizes))],
    ["flicks ending in a correction", pct(t.overshoots, t.flicks)],
    ["take-offs per running minute", per(t.takeoffs, t.runTime)],
    ["take-offs chained from a landing", pct(t.chainedTakeoffs, t.takeoffs)],
    ["health and armor per minute", per(t.gained, t.alive)],
    ["deaths per minute", per(t.deaths, t.alive)],
  ];
}
