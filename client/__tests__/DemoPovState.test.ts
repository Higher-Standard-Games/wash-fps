import { beforeEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import type { InterpolatedEntity } from "../../../../engine/network/client/SnapshotBuffer";
import { DemoPovState, watchedEyePose } from "../DemoPovState";

function sample(overrides: Partial<InterpolatedEntity> = {}): InterpolatedEntity {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    vx: 320,
    vy: 0,
    vz: 0,
    grounded: true,
    crouching: false,
    sliding: false,
    wallJumping: false,
    crouchViewOffset: 0,
    ...overrides,
  };
}

describe("DemoPovState", () => {
  beforeEach(() => {
    // Construction registers the shared live-view bob cvars.
    new DemoPovState();
    Cvar.set("cg_bob", 1);
    Cvar.set("cg_bobamplitude", 1);
    Cvar.set("cg_bobfrequency", 0.03);
    Cvar.set("cg_bobroll", 0.35);
    Cvar.set("cg_boblean", 1);
  });

  it("uses the recorded crouch transition offset with the live standing viewheight", () => {
    const pov = new DemoPovState();
    const standing = pov.update("player_1", sample(), {
      playheadTick: 100,
      tickRate: 125,
      paused: false,
      discontinuityId: 0,
    });
    const crouched = pov.update("player_1", sample({ crouching: true, crouchViewOffset: -24 }), {
      playheadTick: 101,
      tickRate: 125,
      paused: false,
      discontinuityId: 0,
    });

    expect(standing.eyeHeight).toBe(34);
    expect(crouched.eyeHeight).toBe(10);
  });

  it("falls back to crouch state for older samples without a recorded offset", () => {
    const pov = new DemoPovState().update("player_1", sample({ crouching: true, crouchViewOffset: undefined }), {
      playheadTick: 10,
      tickRate: 125,
      paused: false,
      discontinuityId: 0,
    });
    expect(pov.eyeHeight).toBe(10);
  });

  it("advances camera and weapon bob from recorded demo time", () => {
    const pov = new DemoPovState();
    pov.update("player_1", sample(), {
      playheadTick: 0,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });
    const moving = pov.update("player_1", sample(), {
      playheadTick: 10,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });

    expect(moving.demoDeltaSeconds).toBeCloseTo(0.1);
    expect(moving.bobCycle).toBeGreaterThan(0);
    expect(Math.abs(moving.effects.positionOffset.x)).toBeGreaterThan(0);
    expect(Math.abs(moving.effects.positionOffset.y)).toBeGreaterThan(0);
  });

  it("does not advance while paused", () => {
    const state = new DemoPovState();
    state.update("player_1", sample(), {
      playheadTick: 0,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });
    const before = state.update("player_1", sample(), {
      playheadTick: 10,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });
    const paused = state.update("player_1", sample(), {
      playheadTick: 10,
      tickRate: 100,
      paused: true,
      discontinuityId: 0,
    });

    expect(paused.demoDeltaSeconds).toBe(0);
    expect(paused.bobCycle).toBeCloseTo(before.bobCycle);
    expect(paused.effects.positionOffset.x).toBeCloseTo(before.effects.positionOffset.x);
    expect(paused.effects.positionOffset.y).toBeCloseTo(before.effects.positionOffset.y);
  });

  it("reaches the same stride phase for the same recorded time across render cadences", () => {
    const coarse = new DemoPovState();
    coarse.update("player_1", sample(), {
      playheadTick: 0,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });
    const coarseResult = coarse.update("player_1", sample(), {
      playheadTick: 20,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });

    const fine = new DemoPovState();
    fine.update("player_1", sample(), {
      playheadTick: 0,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });
    fine.update("player_1", sample(), {
      playheadTick: 10,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });
    const fineResult = fine.update("player_1", sample(), {
      playheadTick: 20,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });

    expect(fineResult.bobCycle).toBeCloseTo(coarseResult.bobCycle);
  });

  it("resets cosmetic phase on seek and target changes", () => {
    const state = new DemoPovState();
    state.update("player_1", sample(), {
      playheadTick: 0,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });
    expect(
      state.update("player_1", sample(), {
        playheadTick: 10,
        tickRate: 100,
        paused: false,
        discontinuityId: 0,
      }).bobCycle,
    ).toBeGreaterThan(0);

    const sought = state.update("player_1", sample(), {
      playheadTick: 50,
      tickRate: 100,
      paused: false,
      discontinuityId: 1,
    });
    const switched = state.update("player_2", sample(), {
      playheadTick: 50,
      tickRate: 100,
      paused: false,
      discontinuityId: 1,
    });
    expect(sought.bobCycle).toBe(0);
    expect(switched.bobCycle).toBe(0);
  });

  it("suppresses walk bob while sliding and captures landing velocity", () => {
    const state = new DemoPovState();
    state.update("player_1", sample({ grounded: false, vy: -300 }), {
      playheadTick: 0,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });
    const landed = state.update("player_1", sample({ sliding: true }), {
      playheadTick: 10,
      tickRate: 100,
      paused: false,
      discontinuityId: 0,
    });

    expect(landed.landingVelocity).toBe(300);
    expect(landed.effects.positionOffset.x).toBe(0);
  });

  it("dips the view on a landing, as the player's own camera does", () => {
    Cvar.set("cg_landing", 1);
    const state = new DemoPovState();
    const clock = (playheadTick: number) => ({ playheadTick, tickRate: 100, paused: false, discontinuityId: 0 });
    state.update("player_1", sample({ grounded: false, vx: 0, vy: -600 }), clock(0));
    state.update("player_1", sample({ grounded: false, vx: 0, vy: -600 }), clock(1));
    const landed = state.update("player_1", sample({ vx: 0 }), clock(3));

    expect(landed.landingVelocity).toBe(600);
    expect(landed.effects.positionOffset.y).toBeLessThan(0);
  });
});

describe("DemoPovState — the watched player's own motion", () => {
  const clock = (playheadTick: number, paused = false) => ({ playheadTick, tickRate: 100, paused, discontinuityId: 0 });

  it("leans with their strafe keys, as their own screen did", () => {
    Cvar.set("cg_strafetilt", 1.5);
    const pov = new DemoPovState();
    pov.update("player_1", sample({ vx: 0 }), clock(0));
    let roll = 0;
    for (let tick = 1; tick <= 50; tick++)
      roll = pov.update("player_1", sample({ vx: 0, strafeInput: 1 }), clock(tick)).effects.rotationOffset.z;
    expect(roll).toBeLessThan(-1);
  });

  it("dips into a slide and lifts through a ledge grab", () => {
    const pov = new DemoPovState();
    expect(pov.update("player_1", sample({ slidePhase: 1 }), clock(0)).pitchOffset).toBeCloseTo(-0.22);
    let lift = 0;
    for (let tick = 1; tick <= 100; tick++)
      lift = pov.update("player_1", sample({ ledgeGrabPhase: 1 }), clock(tick)).pitchOffset;
    expect(lift).toBeCloseTo(0.15, 2);
  });

  it("eases up a step on its clock, and holds while paused", () => {
    Cvar.set("cl_smoothfactor", 0.15);
    const pov = new DemoPovState();
    pov.update("player_1", sample({ y: 0 }), clock(0));
    const climbing = pov.update("player_1", sample({ y: 16 }), clock(1)).smoothedY;
    expect(climbing).toBeGreaterThan(0);
    expect(climbing).toBeLessThan(16);
    expect(pov.update("player_1", sample({ y: 16 }), clock(1, true)).smoothedY).toBe(climbing);
    expect(watchedEyePose(sample({ y: 16 }), pov.update("player_1", sample({ y: 16 }), clock(1, true))).y).toBeCloseTo(
      climbing + 34,
    );
  });
});
