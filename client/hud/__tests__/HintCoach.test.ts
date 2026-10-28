import { describe, expect, it } from "vitest";
import { HINT_REPEAT_MS, HintCoach, type MovementSample, SLIDE_SPEED, type StatusSample } from "../HintCoach";

const still: MovementSample = {
  grounded: true,
  sliding: false,
  horizontalSpeed: 0,
  verticalSpeed: 0,
  wallJump: "none",
};
const running: MovementSample = { ...still, horizontalSpeed: SLIDE_SPEED + 20 };

/** Feed samples every 16 ms, as movement steps arrive; returns the hints offered. */
function run(c: HintCoach, sample: MovementSample, from: number, ms: number): string[] {
  const hints: string[] = [];
  for (let t = from; t < from + ms; t += 16) {
    const hint = c.observe(sample, t);
    if (hint) hints.push(hint);
  }
  return hints;
}

describe("HintCoach", () => {
  it("offers the slide hint once the player runs fast enough to slide for a moment", () => {
    const c = new HintCoach();
    expect(run(c, running, 0, 250)).toEqual([]);
    expect(run(c, running, 250, 150)).toEqual(["slide"]);
  });

  it("offers no slide hint to a player who is sliding, or too slow to slide", () => {
    const c = new HintCoach();
    expect(run(c, { ...running, sliding: true }, 0, 2000)).toEqual([]);
    expect(run(c, { ...running, horizontalSpeed: SLIDE_SPEED - 1 }, 2000, 2000)).toEqual([]);
  });

  it("offers the walljump hint in the air beside a wall", () => {
    expect(new HintCoach().observe({ ...still, grounded: false, wallJump: "available" }, 0)).toBe("walljump");
  });

  it("offers a hop hint after two jumps within two seconds, either the bunny hop or the slide one", () => {
    const jumpAt = (c: HintCoach, t: number) => {
      c.observe(still, t);
      return c.observe({ ...still, grounded: false, verticalSpeed: 320 }, t + 16);
    };
    for (const [random, expected] of [
      [0.2, "bunnyhop"],
      [0.8, "slidespeed"],
    ] as const) {
      const c = new HintCoach(() => random);
      expect(jumpAt(c, 0)).toBeNull();
      expect(jumpAt(c, 900)).toBe(expected);
    }
  });

  it("offers the walljump hint on a third jump in a row", () => {
    const c = new HintCoach(() => 0.2);
    const jumpAt = (t: number) => {
      c.observe(still, t);
      return c.observe({ ...still, grounded: false, verticalSpeed: 320 }, t + 16);
    };
    expect(jumpAt(0)).toBeNull();
    expect(jumpAt(900)).toBe("bunnyhop");
    expect(jumpAt(1800)).toBe("walljump");
  });

  it("offers the aim hint on a hip shot with a weapon that can aim", () => {
    const c = new HintCoach();
    expect(c.shot(0, true, false)).toBeNull();
    expect(c.shot(0, false, true)).toBeNull();
    expect(c.shot(0, true, true)).toBe("aim");
  });

  it("offers the aim hint once fire is held from the hip for a second", () => {
    const c = new HintCoach();
    expect(c.holdingFire(0, true)).toBeNull();
    expect(c.holdingFire(900, true)).toBeNull();
    // Letting go, or aiming, starts it over
    expect(c.holdingFire(950, false)).toBeNull();
    expect(c.holdingFire(1000, true)).toBeNull();
    expect(c.holdingFire(1999, true)).toBeNull();
    expect(c.holdingFire(2000, true)).toBe("aim");
  });

  it("offers the landing hint on fall damage", () => {
    expect(new HintCoach().fell(0)).toBe("fall");
  });

  it("shows a different hint at once, and the same hint at most once a minute", () => {
    const c = new HintCoach();
    expect(c.fell(0)).toBe("fall");
    expect(c.shot(100, true, true)).toBe("aim");
    expect(c.fell(HINT_REPEAT_MS - 1)).toBeNull();
    expect(c.fell(HINT_REPEAT_MS)).toBe("fall");
  });

  it("offers the strafe hint to a player hopping with forward alone, the bunny hop hint otherwise", () => {
    const hop = (c: HintCoach, t: number, air: Partial<MovementSample>) => {
      return (
        c.observe({ ...still, forward: true }, t) ??
        c.observe({ ...still, grounded: false, verticalSpeed: 320, ...air }, t + 16) ??
        c.observe({ ...still, grounded: false, verticalSpeed: 0, ...air }, t + 300)
      );
    };
    const forwardOnly = new HintCoach(() => 0.2);
    hop(forwardOnly, 0, { forward: true });
    expect(hop(forwardOnly, 900, { forward: true })).toBe("strafe");
    const strafer = new HintCoach(() => 0.2);
    hop(strafer, 0, { forward: true, strafing: true });
    expect(hop(strafer, 900, { forward: true, strafing: true })).toBe("bunnyhop");
  });

  it("offers the ledge hint on grabbing a ledge", () => {
    const c = new HintCoach();
    c.observe({ ...still, grounded: false, ledgeGrab: "none" }, 0);
    expect(c.observe({ ...still, grounded: false, ledgeGrab: "grabbing" }, 16)).toBe("ledge");
  });

  describe("status hints", () => {
    const fine: StatusSample = {
      health: 100,
      armor: 50,
      liveForMs: null,
      weapon: "machinegun",
      carriesGun: true,
      grounded: true,
      waterLevel: 0,
      air: 1,
      carriesBomb: false,
      defendingPlantedBomb: false,
    };
    /** Status every 50 ms, as the HUD ticks; returns the hints offered. */
    const tick = (c: HintCoach, s: Partial<StatusSample>, from: number, ms: number) => {
      const hints: string[] = [];
      for (let t = from; t <= from + ms; t += 50) {
        const hint = c.status({ ...fine, ...s }, t);
        if (hint) hints.push(hint);
      }
      return hints;
    };

    it("says nothing to a player who is fine", () => {
      expect(tick(new HintCoach(), {}, 0, 30_000)).toEqual([]);
    });

    it("points a hurt player to health after a few seconds, not on the first hit", () => {
      const c = new HintCoach();
      expect(tick(c, { health: 40 }, 0, 2900)).toEqual([]);
      expect(tick(c, { health: 40 }, 2950, 100)).toEqual(["health"]);
    });

    it("points to armor after 15 s without any in a live match, never in warmup", () => {
      expect(tick(new HintCoach(), { armor: 0 }, 0, 30_000)).toEqual([]);
      const c = new HintCoach();
      expect(tick(c, { armor: 0, liveForMs: 0 }, 0, 14_900)).toEqual([]);
      expect(tick(c, { armor: 0, liveForMs: 15_000 }, 14_950, 100)).toEqual(["armor"]);
    });

    it("warns about the shock and the air at once", () => {
      expect(tick(new HintCoach(), { weapon: "voltaic", waterLevel: 2 }, 0, 0)).toEqual(["shock"]);
      expect(tick(new HintCoach(), { weapon: "machinegun", waterLevel: 3 }, 0, 0)).toEqual([]);
      expect(tick(new HintCoach(), { air: 0.4 }, 0, 0)).toEqual(["air"]);
    });

    it("suggests switching from the blade to a carried gun, and the blade's blast to one who never charges it", () => {
      expect(tick(new HintCoach(), { weapon: "blade" }, 0, 8000)).toEqual(["switch"]);
      const c = new HintCoach();
      tick(c, { weapon: "blade", carriesGun: false }, 0, 6000);
      c.charged(6000);
      expect(tick(c, { weapon: "blade", carriesGun: false }, 6050, 11_900)).toEqual([]);
      expect(tick(c, { weapon: "blade", carriesGun: false }, 18_000, 100)).toEqual(["blade"]);
    });

    it("suggests rocket jumping after ten seconds on the ground with the rocket launcher, in all", () => {
      const c = new HintCoach();
      expect(tick(c, { weapon: "rlauncher" }, 0, 6000)).toEqual([]);
      expect(tick(c, { weapon: "rlauncher", grounded: false }, 6050, 5000)).toEqual([]);
      expect(tick(c, { weapon: "rlauncher" }, 11_100, 4100)).toEqual(["rocketjump"]);
    });

    it("tells about bouncing grenades and the scoreboard once only", () => {
      const c = new HintCoach();
      expect(tick(c, { weapon: "glauncher" }, 0, 0)).toEqual(["grenade"]);
      expect(tick(c, { weapon: "glauncher" }, HINT_REPEAT_MS * 2, 0)).toEqual([]);
      expect(tick(c, { liveForMs: 19_000 }, 0, 0)).toEqual([]);
      expect(tick(c, { liveForMs: 20_000 }, 100, 0)).toEqual(["scoreboard"]);
      expect(tick(c, { liveForMs: 200_000 }, HINT_REPEAT_MS * 3, 0)).toEqual([]);
    });

    it("tells the bomb carrier how to arm and a defender how to defuse", () => {
      expect(tick(new HintCoach(), { carriesBomb: true }, 0, 3000)).toEqual(["plant"]);
      expect(tick(new HintCoach(), { defendingPlantedBomb: true }, 0, 0)).toEqual(["defuse"]);
    });
  });

  it("offers the reload hint when the clip runs dry", () => {
    expect(new HintCoach().clipEmptied(0)).toBe("reload");
  });
});
