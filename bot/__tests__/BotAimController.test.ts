/**
 * The bot's view turns like a hand on a mouse: eased, with a top speed, a
 * pause before big turns, no twitch at small changes of mind, and an aim
 * error that wanders instead of shaking.
 */

import { describe, expect, it } from "vitest";
import { aimTuning, BotAimController, wrapAngle } from "../BotAimController";
import { DIFFICULTY_PRESETS } from "../BotConfig";

const DT = 0.008;
const DEG = Math.PI / 180;
/** No wander and no reaction jitter, so turns can be measured exactly. */
const steady = () => 0.5;

function exact(preset: keyof typeof DIFFICULTY_PRESETS) {
  return { ...DIFFICULTY_PRESETS[preset], aimAccuracy: 1 };
}

/** Run `seconds` toward fixed angles; the yaw sent each command. */
function run(aim: BotAimController, seconds: number, yaw: number, pitch = 0, firing = true): number[] {
  const out: number[] = [];
  for (let t = 0; t < seconds; t += DT) out.push(aim.step(DT, yaw, pitch, firing).yaw);
  return out;
}

describe("aim tuning", () => {
  it("derives the presets' speeds from trackingSpeed alone", () => {
    const easy = aimTuning(DIFFICULTY_PRESETS.easy);
    const insane = aimTuning(DIFFICULTY_PRESETS.insane);
    expect(easy.maxYawSpeed / DEG).toBeCloseTo(150, 6);
    expect(insane.maxYawSpeed / DEG).toBeCloseTo(800, 6);
    expect(easy.maxPitchSpeed).toBeCloseTo(easy.maxYawSpeed * 0.6, 9);
    expect(easy.settleSeconds).toBeCloseTo(0.5 / Math.sqrt(1.5), 9);
    expect(easy.deadzone / DEG).toBeCloseTo(4, 6);
    expect(aimTuning(DIFFICULTY_PRESETS.medium).deadzone / DEG).toBeCloseTo(3, 6);
    expect(aimTuning(DIFFICULTY_PRESETS.hard).deadzone / DEG).toBeCloseTo(2, 6);
    expect(insane.deadzone / DEG).toBeCloseTo(1.5, 6);
  });
});

describe("BotAimController", () => {
  it("eases into a small turn without overshooting", () => {
    const aim = new BotAimController(exact("medium"), steady);
    aim.reset(0, 0);
    const yaws = run(aim, 1, 20 * DEG);
    expect(Math.max(...yaws)).toBeLessThanOrEqual(20 * DEG + 1e-9);
    // Starts slowly, as a hand does, then settles within its settle time.
    expect(yaws[0]).toBeLessThan(0.5 * DEG);
    const settled = yaws.findIndex((yaw) => yaw > 19 * DEG) * DT;
    expect(settled).toBeGreaterThan(0.1);
    expect(settled).toBeLessThan(aimTuning(exact("medium")).settleSeconds * 1.2);
  });

  it("never turns faster than its top speed", () => {
    for (const preset of ["easy", "insane"] as const) {
      const aim = new BotAimController({ ...exact(preset), reactionTimeMs: 0 }, steady);
      aim.reset(0, 0);
      const yaws = run(aim, 3, 179 * DEG);
      const top = aimTuning(exact(preset)).maxYawSpeed;
      for (let i = 1; i < yaws.length; i++)
        expect(Math.abs(yaws[i] - yaws[i - 1]) / DT).toBeLessThanOrEqual(top + 1e-6);
      expect(yaws[yaws.length - 1]).toBeCloseTo(179 * DEG, 2);
    }
    // Half a turn at 150°/s takes the easy bot over a second.
    const easy = new BotAimController({ ...exact("easy"), reactionTimeMs: 0 }, steady);
    easy.reset(0, 0);
    expect(run(easy, 1, 179 * DEG).at(-1)).toBeLessThan(160 * DEG);
  });

  it("turns the short way across ±180°", () => {
    const aim = new BotAimController(exact("hard"), steady);
    aim.reset(170 * DEG, 0);
    const yaws = run(aim, 1, -170 * DEG);
    expect(Math.abs(wrapAngle(yaws.at(-1)! - -170 * DEG))).toBeLessThan(0.1 * DEG);
    for (const yaw of yaws) expect(Math.abs(yaw)).toBeGreaterThan(165 * DEG);
  });

  it("ignores small changes of mind unless firing", () => {
    const aim = new BotAimController(exact("easy"), steady);
    aim.reset(0, 0);
    expect(run(aim, 0.5, 3 * DEG, 0, false).at(-1)).toBe(0);
    expect(run(aim, 0.5, 5 * DEG, 0, false).at(-1)).toBeGreaterThan(4 * DEG);

    aim.reset(0, 0);
    expect(run(aim, 0.5, 3 * DEG, 0, true).at(-1)).toBeGreaterThan(2.5 * DEG);
  });

  it("waits its reaction time before a big turn", () => {
    const aim = new BotAimController(exact("medium"), steady); // 280 ms
    aim.reset(0, 0);
    const yaws = run(aim, 1, 90 * DEG);
    const started = yaws.findIndex((yaw) => yaw > 0.01 * DEG) * DT;
    expect(started).toBeGreaterThan(0.27);
    expect(started).toBeLessThan(0.3);

    // The jitter is ±20%.
    const late = new BotAimController(exact("medium"), () => 0.999);
    late.reset(0, 0);
    expect(run(late, 1, 90 * DEG).findIndex((yaw) => yaw > 0) * DT).toBeGreaterThan(0.32);
  });

  it("drops a big turn the brain takes back before it reacts", () => {
    const aim = new BotAimController(exact("easy"), steady); // 450 ms
    aim.reset(0, 0);
    run(aim, 0.2, 120 * DEG);
    expect(run(aim, 0.5, 0).at(-1)).toBe(0);
  });

  it("keeps up with a target it is shooting at, without trailing behind it", () => {
    for (const preset of ["easy", "insane"] as const) {
      const aim = new BotAimController(exact(preset), steady);
      aim.reset(0, 0);
      // The target crosses at 30°/s; the brain re-aims every fourth command.
      let worst = 0;
      for (let tick = 0; tick < 250; tick++) {
        const wanted = 30 * DEG * DT * (tick - (tick % 4));
        const yaw = aim.step(DT, wanted, 0, true).yaw;
        if (tick > 125) worst = Math.max(worst, Math.abs(yaw - 30 * DEG * DT * tick));
      }
      expect(worst).toBeLessThan(0.5 * DEG);
    }
  });

  it("does not overshoot when it switches to another target", () => {
    const aim = new BotAimController(exact("insane"), steady);
    aim.reset(0, 0);
    for (let tick = 0; tick < 60; tick++) aim.step(DT, 0.1 * DEG * Math.floor(tick / 4), 0, true);
    const from = aim.step(DT, 6 * DEG, 0, true).yaw;
    const yaws = run(aim, 1, from + 20 * DEG);
    expect(Math.max(...yaws)).toBeLessThan(from + 20.2 * DEG);
  });

  it("lets its aim error wander slowly, sized by accuracy", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const spread = (accuracy: number) => {
      const aim = new BotAimController({ ...DIFFICULTY_PRESETS.medium, aimAccuracy: accuracy }, random);
      aim.reset(0, 0);
      const yaws = run(aim, 60, 0);
      let sum = 0;
      let largestStep = 0;
      for (let i = 0; i < yaws.length; i++) {
        sum += yaws[i] * yaws[i];
        if (i > 0) largestStep = Math.max(largestStep, Math.abs(yaws[i] - yaws[i - 1]));
      }
      return { rms: Math.sqrt(sum / yaws.length), largestStep };
    };
    const sloppy = spread(0.25);
    const sharp = spread(0.92);
    const sigma = aimTuning({ ...DIFFICULTY_PRESETS.medium, aimAccuracy: 0.25 }).driftSigma;
    expect(sloppy.rms).toBeGreaterThan(sigma * 0.4);
    expect(sloppy.rms).toBeLessThan(sigma * 1.6);
    expect(sharp.rms).toBeLessThan(sloppy.rms / 4);
    // A wander, not a shake: the old noise could move the view by its whole
    // width (6° here) at each decision; no command moves it a fifth of a degree.
    expect(sloppy.largestStep).toBeLessThan(sigma * 0.1);
  });
});

describe("BotAimController calm", () => {
  /** The yaw sent each command toward a fixed calm goal. */
  function calm(aim: BotAimController, seconds: number, yaw: number, pitch = 0): number[] {
    const out: number[] = [];
    for (let t = 0; t < seconds; t += DT) out.push(aim.step(DT, yaw, pitch, false, true).yaw);
    return out;
  }

  it("eases a planned turn at most 120°/s, with no reaction wait", () => {
    const aim = new BotAimController(exact("insane"), steady);
    aim.reset(0, 0);
    const yaws = calm(aim, 2, 80 * DEG);
    // It starts at once: there is nothing to notice.
    expect(yaws[Math.round(0.1 / DT)]).toBeGreaterThan(1 * DEG);
    let fastest = 0;
    for (let i = 1; i < yaws.length; i++) fastest = Math.max(fastest, Math.abs(yaws[i] - yaws[i - 1]) / DT);
    expect(fastest / DEG).toBeLessThan(125);
    expect(yaws[yaws.length - 1] / DEG).toBeGreaterThan(75);
  });

  it("ignores small changes of mind", () => {
    const aim = new BotAimController(exact("medium"), steady);
    aim.reset(0, 0);
    // Five medium deadzones are 15°.
    const yaws = calm(aim, 1, 12 * DEG);
    expect(Math.abs(yaws[yaws.length - 1])).toBeLessThan(0.5 * DEG);
  });

  it("still looks down a few degrees", () => {
    const aim = new BotAimController(exact("medium"), steady);
    aim.reset(0, 0);
    let pitch = 0;
    for (let t = 0; t < 2; t += DT) pitch = aim.step(DT, 0, 10 * DEG, false, true).pitch;
    expect(pitch / DEG).toBeGreaterThan(8);
  });

  it("turns round the ordinary way: a pause, then a fast turn", () => {
    const aim = new BotAimController(exact("insane"), steady);
    aim.reset(0, 0);
    const yaws = calm(aim, 1.5, 170 * DEG);
    const reaction = aimTuning(exact("insane")).reactionMs / 1000;
    expect(Math.abs(yaws[Math.floor((reaction * 0.5) / DT)])).toBeLessThan(0.5 * DEG);
    let fastest = 0;
    for (let i = 1; i < yaws.length; i++) fastest = Math.max(fastest, Math.abs(wrapAngle(yaws[i] - yaws[i - 1])) / DT);
    expect(fastest / DEG).toBeGreaterThan(300);
  });
});

describe("BotAimController reactions and flicks", () => {
  /** Steps until the view first moves; seconds. */
  function reactionWith(random: () => number): number {
    const aim = new BotAimController(exact("medium"), random);
    aim.reset(0, 0);
    for (let t = 0; t < 2; t += DT) if (Math.abs(aim.step(DT, 120 * DEG, 0, true).yaw) > 0.5 * DEG) return t;
    return 2;
  }

  it("waits the preset's reaction time at the median draw, and longer in the tail", () => {
    const median = reactionWith(() => 0.5);
    const slow = reactionWith(() => 0.99);
    const reaction = DIFFICULTY_PRESETS.medium.reactionTimeMs / 1000;
    expect(median).toBeGreaterThan(reaction * 0.9);
    expect(median).toBeLessThan(reaction * 1.25);
    expect(slow).toBeGreaterThan(median * 1.6);
  });

  it("sometimes flicks past a big turn and comes back", () => {
    // Draws below the overshoot chance: the turn goes past, then settles on the goal.
    const aim = new BotAimController({ ...exact("easy"), aimAccuracy: 0.25 }, () => 0.1);
    aim.reset(0, 0);
    const yaws: number[] = [];
    for (let t = 0; t < 2.5; t += DT) yaws.push(aim.step(DT, 90 * DEG, 0, true).yaw);
    // Low accuracy also leaves a steady aim offset; the flick goes past where the view settles.
    const settled = yaws[yaws.length - 1];
    expect((Math.max(...yaws) - settled) / DEG).toBeGreaterThan(2);
  });
});
