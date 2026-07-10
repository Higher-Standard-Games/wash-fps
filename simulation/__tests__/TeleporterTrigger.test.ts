import { describe, expect, it } from "vitest";
import type { MovementInput } from "../../../../engine/network/systems/movement/MovementProfile";
import type { TriggerVolume } from "../../../../shared/bsp/TriggerTable";
import { MovementProfile } from "../MovementProfile";

/**
 * WO-T3 — teleporters (trigger_teleport) inside the shared MovementProfile.
 * Primary fixture: the REAL wdm2 teleporter *1 → t1 (Babylon space).
 */

const TELE_1: TriggerVolume = {
  id: 0,
  type: "teleport",
  min: { x: -1032, y: 208, z: -272 },
  max: { x: -992, y: 384, z: -112 },
  dest: { x: -784, y: 424, z: -192 },
  destYaw: Math.PI / 2, // wdm2 t1: angle ≈ 0 → game yaw π/2
};

/** Synthetic pad whose volume CONTAINS the exit of TELE_CHAIN (for 1-per-step tests). */
const PAD_AT_EXIT: TriggerVolume = {
  id: 3,
  type: "push",
  min: { x: -50, y: 0, z: -50 },
  max: { x: 50, y: 60, z: 50 },
  dest: { x: 0, y: 400, z: 0 },
};

/** Teleporter whose dest lands inside PAD_AT_EXIT's volume. */
const TELE_INTO_PAD: TriggerVolume = {
  id: 1,
  type: "teleport",
  min: { x: 500, y: 0, z: 500 },
  max: { x: 600, y: 100, z: 600 },
  dest: { x: 0, y: 0, z: 0 }, // exit origin ends at y=25 — inside the pad box
  destYaw: 0,
};

const DT = 1 / 125;
const IN_TELE_1 = { x: -1012, y: 300, z: -192 };

function input(seq: number): MovementInput {
  return {
    direction: { x: 0, y: 0, z: 0 },
    viewAngles: { pitch: 0, yaw: 0 },
    buttons: 0,
    sequence: seq,
    isPressed: () => false,
  } as MovementInput;
}

describe("MovementProfile teleporters (WO-T3)", () => {
  it("relocates to dest + waist lift, flags the result, reports the exit yaw", () => {
    const profile = new MovementProfile();
    profile.setTriggerVolumes([TELE_1]);
    const result = profile.simulate(IN_TELE_1, { x: 0, y: 0, z: 0 }, input(1), DT, null);

    expect(result.teleported).toBe(true);
    expect(result.triggerId).toBe(0);
    expect(result.teleportYaw).toBeCloseTo(Math.PI / 2, 9);
    expect(result.position.x).toBe(-784);
    expect(result.position.y).toBe(424 + 25); // dest + PLAYER_ORIGIN_HEIGHT(24) + 1
    expect(result.position.z).toBe(-192);
    expect(result.grounded).toBe(false);
  });

  it("default policy preserves horizontal speed, redirected along the exit yaw (vy zeroed)", () => {
    const profile = new MovementProfile();
    profile.setTriggerVolumes([TELE_1]);
    // hypot(300, 400) = 500 ups horizontal, plus downward fall to discard.
    const result = profile.simulate(IN_TELE_1, { x: 300, y: -350, z: 400 }, input(1), DT, null);

    // Exit yaw π/2 → forward = (sin, 0, cos) = (+x)
    expect(result.velocity.x).toBeCloseTo(500, 6);
    expect(result.velocity.y).toBe(0);
    expect(result.velocity.z).toBeCloseTo(0, 6);
  });

  it("Q3 policy (teleportSpeedMode 0) exits at fixed teleportExitSpeed", () => {
    const profile = new MovementProfile({ teleportSpeedMode: 0 });
    profile.setTriggerVolumes([TELE_1]);
    const result = profile.simulate(IN_TELE_1, { x: 900, y: 0, z: 0 }, input(1), DT, null);

    expect(result.velocity.x).toBeCloseTo(400, 6);
    expect(result.velocity.y).toBe(0);
    expect(result.velocity.z).toBeCloseTo(0, 6);
  });

  it("missing destYaw defaults to 0", () => {
    const noYaw: TriggerVolume = { ...TELE_1, destYaw: undefined };
    const profile = new MovementProfile();
    profile.setTriggerVolumes([noYaw]);
    const result = profile.simulate(IN_TELE_1, { x: 100, y: 0, z: 0 }, input(1), DT, null);

    expect(result.teleportYaw).toBe(0);
    // yaw 0 → forward = (0, 0, 1)
    expect(result.velocity.x).toBeCloseTo(0, 6);
    expect(result.velocity.z).toBeCloseTo(100, 6);
  });

  it("fires at most ONE trigger per step: a teleport into a pad volume launches on the NEXT step", () => {
    const profile = new MovementProfile();
    profile.setTriggerVolumes([TELE_INTO_PAD, PAD_AT_EXIT]);

    const r1 = profile.simulate({ x: 550, y: 50, z: 550 }, { x: 0, y: 0, z: 0 }, input(1), DT, null);
    expect(r1.teleported).toBe(true);
    expect(r1.jumppadLaunch).toBe(false); // pad NOT evaluated on the teleport step
    expect(r1.velocity.y).toBe(0);

    const r2 = profile.simulate(r1.position, r1.velocity, input(2), DT, null);
    expect(r2.teleported).toBe(false);
    expect(r2.jumppadLaunch).toBe(true); // pad fires one step later
    expect(r2.velocity.y).toBeGreaterThan(500);
  });

  it("does not teleport away from the volume, and an empty profile is unaffected", () => {
    const profile = new MovementProfile();
    profile.setTriggerVolumes([TELE_1]);
    const away = profile.simulate({ x: 0, y: 300, z: 0 }, { x: 0, y: 0, z: 0 }, input(1), DT, null);
    expect(away.teleported).toBe(false);

    const bare = new MovementProfile();
    const r = bare.simulate(IN_TELE_1, { x: 0, y: 0, z: 0 }, input(1), DT, null);
    expect(r.teleported).toBe(false);
  });

  it("does not spike actualHorizSpeed on the teleport step (animation/speedometer)", () => {
    const profile = new MovementProfile();
    profile.setTriggerVolumes([TELE_1]);
    const result = profile.simulate(IN_TELE_1, { x: 200, y: 0, z: 0 }, input(1), DT, null);

    expect(result.teleported).toBe(true);
    // Speed sampled from the PRE-teleport movement (~200 ups), not the map-crossing jump.
    expect(result.actualHorizSpeed).toBeLessThan(300);
  });

  it("is replay-idempotent through a teleport (two profiles, same sequence)", () => {
    const a = new MovementProfile();
    const b = new MovementProfile();
    a.setTriggerVolumes([TELE_1]);
    b.setTriggerVolumes([TELE_1]);

    let posA = { ...IN_TELE_1 };
    let velA = { x: 250, y: 0, z: -80 };
    let posB = { ...IN_TELE_1 };
    let velB = { x: 250, y: 0, z: -80 };

    for (let seq = 1; seq <= 40; seq++) {
      const ra = a.simulate(posA, velA, input(seq), DT, null);
      const rb = b.simulate(posB, velB, input(seq), DT, null);
      posA = ra.position;
      velA = ra.velocity;
      posB = rb.position;
      velB = rb.velocity;
    }

    expect(posA).toEqual(posB);
    expect(velA).toEqual(velB);
  });
});
