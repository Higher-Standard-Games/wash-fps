import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import type { MovementInput } from "../../../../engine/network/systems/movement/MovementProfile";
import type { TriggerVolume } from "../../../../shared/bsp/TriggerTable";
import { MovementProfile } from "../MovementProfile";

/**
 * WO-T2 — jumppads (trigger_push) inside the shared MovementProfile.
 * The primary fixture is the REAL wdm2 mega pad (Babylon space, from the
 * shared TriggerTable extraction — see docs/research/triggerbrushes-and-targets.md):
 * a 128×16×128 floor pad whose target sits exactly 304u above its center.
 */

const WDM2_MEGA_PAD: TriggerVolume = {
  id: 2,
  type: "push",
  min: { x: -48, y: 0, z: -976 },
  max: { x: 80, y: 16, z: -848 },
  dest: { x: 16, y: 312, z: -912 },
};

/** Synthetic angled pad: same footprint, target 200u forward (+x) and 304 up. */
const ANGLED_PAD: TriggerVolume = {
  id: 5,
  type: "push",
  min: { x: -48, y: 0, z: -976 },
  max: { x: 80, y: 16, z: -848 },
  dest: { x: 216, y: 312, z: -912 },
};

/** Invalid pad: target BELOW the pad center. */
const INVALID_PAD: TriggerVolume = {
  id: 7,
  type: "push",
  min: { x: -48, y: 0, z: -976 },
  max: { x: 80, y: 16, z: -848 },
  dest: { x: 16, y: -100, z: -912 },
};

const GRAVITY = 1000; // MovementProfile default

const DT = 1 / 125;
const ON_PAD = { x: 16, y: 8, z: -912 }; // player origin inside the pad volume
const OFF_PAD = { x: 500, y: 8, z: 500 };

/**
 * The profile solves AimAtTarget from the player's END-OF-STEP position
 * (stateless per-position solve — see MovementProfile.setTriggerVolumes).
 * Derive the exact expected launch from the returned fire position.
 */
function expectedLaunch(dest: { x: number; y: number; z: number }, firePos: { x: number; y: number; z: number }) {
  const time = Math.sqrt((dest.y - firePos.y) / (0.5 * GRAVITY));
  return {
    x: (dest.x - firePos.x) / time,
    y: GRAVITY * time,
    z: (dest.z - firePos.z) / time,
  };
}

function input(seq: number, buttons = 0): MovementInput {
  return {
    direction: { x: 0, y: 0, z: 0 },
    viewAngles: { pitch: 0, yaw: 0 },
    buttons,
    sequence: seq,
    isPressed: (button: number) => (buttons & button) !== 0,
  } as MovementInput;
}

function makeProfile(volumes: TriggerVolume[]): MovementProfile {
  const profile = new MovementProfile();
  profile.setTriggerVolumes(volumes);
  return profile;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MovementProfile jumppads (WO-T2)", () => {
  it("launches with the AimAtTarget solve on the wdm2 mega pad (dead vertical)", () => {
    const profile = makeProfile([WDM2_MEGA_PAD]);
    const result = profile.simulate(ON_PAD, { x: 0, y: 0, z: 0 }, input(1), DT, null);
    const launch = expectedLaunch(WDM2_MEGA_PAD.dest, result.position);

    expect(result.jumppadLaunch).toBe(true);
    expect(result.triggerId).toBe(2);
    expect(result.grounded).toBe(false);
    expect(result.velocity.x).toBeCloseTo(0, 6); // fired from x=16 = dest.x
    expect(result.velocity.z).toBeCloseTo(0, 6);
    expect(result.velocity.y).toBeCloseTo(launch.y, 6); // ≈ 780 (height ≈ 304)
    expect(result.velocity.y).toBeGreaterThan(770);
    expect(result.velocity.y).toBeLessThan(790);
  });

  it("solves horizontal travel for an angled pad (v_xy = Δxz / time)", () => {
    const profile = makeProfile([ANGLED_PAD]);
    const result = profile.simulate(ON_PAD, { x: 0, y: 0, z: 0 }, input(1), DT, null);
    const launch = expectedLaunch(ANGLED_PAD.dest, result.position);

    expect(result.jumppadLaunch).toBe(true);
    expect(result.velocity.x).toBeCloseTo(launch.x, 6); // ≈ 200/time ≈ 256.5
    expect(result.velocity.x).toBeGreaterThan(240);
    expect(result.velocity.y).toBeCloseTo(launch.y, 6);
    expect(result.velocity.z).toBeCloseTo(0, 6);
  });

  it("REPLACES velocity (Q3), it does not add — incoming speed is discarded", () => {
    const profile = makeProfile([WDM2_MEGA_PAD]);
    const result = profile.simulate(ON_PAD, { x: 900, y: -400, z: -300 }, input(1), DT, null);
    const launch = expectedLaunch(WDM2_MEGA_PAD.dest, result.position);

    // Fully replaced with the aim-at-target solve — the 900 ups incoming
    // horizontal speed is gone (only the small re-aim correction remains).
    expect(result.velocity.x).toBeCloseTo(launch.x, 6);
    expect(Math.abs(result.velocity.x)).toBeLessThan(30);
    expect(result.velocity.y).toBeCloseTo(launch.y, 6);
    expect(result.velocity.y).toBeGreaterThan(700);
  });

  it("re-touching while still inside the volume re-aims instead of stacking", () => {
    const profile = makeProfile([WDM2_MEGA_PAD]);
    const r1 = profile.simulate(ON_PAD, { x: 0, y: 0, z: 0 }, input(1), DT, null);
    // Next tick starts from r1 — still inside the 16u-tall volume after 8ms.
    const r2 = profile.simulate(r1.position, r1.velocity, input(2), DT, null);

    expect(r2.jumppadLaunch).toBe(true);
    // Re-fire from a higher position aims at the SAME target: vy shrinks
    // (shorter remaining arc), never grows — no re-fire accumulation.
    expect(r2.velocity.y).toBeLessThan(r1.velocity.y);
    expect(r2.velocity.y).toBeCloseTo(expectedLaunch(WDM2_MEGA_PAD.dest, r2.position).y, 6);
  });

  it("does nothing away from the pad", () => {
    const profile = makeProfile([WDM2_MEGA_PAD]);
    const result = profile.simulate(OFF_PAD, { x: 0, y: 0, z: 0 }, input(1), DT, null);

    expect(result.jumppadLaunch).toBe(false);
    expect(result.triggerId).toBeUndefined();
    expect(result.velocity.y).toBeLessThan(0); // just gravity
  });

  it("does nothing when no trigger volumes are installed (default profile)", () => {
    const profile = new MovementProfile();
    const result = profile.simulate(ON_PAD, { x: 0, y: 0, z: 0 }, input(1), DT, null);

    expect(result.jumppadLaunch).toBe(false);
  });

  it("drops pads whose target is not above the pad (invalid AimAtTarget)", () => {
    const profile = makeProfile([INVALID_PAD]);
    const result = profile.simulate(ON_PAD, { x: 0, y: 0, z: 0 }, input(1), DT, null);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("target not above pad"));
    expect(result.jumppadLaunch).toBe(false);
  });

  it("ignores teleport volumes for now (T3)", () => {
    const teleport: TriggerVolume = {
      id: 0,
      type: "teleport",
      min: WDM2_MEGA_PAD.min,
      max: WDM2_MEGA_PAD.max,
      dest: { x: 0, y: 424, z: 0 },
      destYaw: Math.PI / 2,
    };
    const profile = makeProfile([teleport]);
    const result = profile.simulate(ON_PAD, { x: 0, y: 0, z: 0 }, input(1), DT, null);

    expect(result.jumppadLaunch).toBe(false);
  });

  it("is replay-idempotent: two profiles running the same input sequence agree exactly", () => {
    const a = makeProfile([WDM2_MEGA_PAD, ANGLED_PAD]);
    const b = makeProfile([WDM2_MEGA_PAD, ANGLED_PAD]);

    let posA = { ...ON_PAD };
    let velA = { x: 120, y: 0, z: -40 };
    let posB = { ...ON_PAD };
    let velB = { x: 120, y: 0, z: -40 };

    // Fly through the pad launch and 60 ticks of flight, forward held.
    for (let seq = 1; seq <= 60; seq++) {
      const ra = a.simulate(posA, velA, input(seq, InputButtons.FORWARD), DT, null);
      const rb = b.simulate(posB, velB, input(seq, InputButtons.FORWARD), DT, null);
      posA = ra.position;
      velA = ra.velocity;
      posB = rb.position;
      velB = rb.velocity;
    }

    expect(posA).toEqual(posB);
    expect(velA).toEqual(velB);
  });

  it("full-arc integration lands the apex ON the target height (re-aim beats Q3 overshoot)", () => {
    // Integrate the launch to apex with the profile itself. Per-position
    // re-aiming makes the LAST fire inside the volume aim exactly at dest
    // (y=312), so the apex should sit at ~dest height ± Euler discretization —
    // Q3's fixed-velocity pads overshoot here by the re-fire accumulation
    // (~+28u for this pad), which is the bug this design avoids.
    const profile = makeProfile([WDM2_MEGA_PAD]);
    let pos = { ...ON_PAD };
    let vel = { x: 0, y: 0, z: 0 };
    let apex = pos.y;

    for (let seq = 1; seq <= 150; seq++) {
      const r = profile.simulate(pos, vel, input(seq), DT, null);
      pos = r.position;
      vel = r.velocity;
      apex = Math.max(apex, pos.y);
      if (vel.y < 0) break;
    }

    expect(apex).toBeGreaterThan(WDM2_MEGA_PAD.dest.y - 8);
    expect(apex).toBeLessThan(WDM2_MEGA_PAD.dest.y + 8);
  });
});
