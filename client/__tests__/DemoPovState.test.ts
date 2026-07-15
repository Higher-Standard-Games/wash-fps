import { beforeEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import type { InterpolatedEntity } from "../../../../engine/network/client/SnapshotBuffer";
import { DemoPovState } from "../DemoPovState";

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
    expect(Math.abs(moving.cameraBobRight)).toBeGreaterThan(0);
    expect(Math.abs(moving.cameraBobUp)).toBeGreaterThan(0);
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
    expect(paused.cameraBobRight).toBeCloseTo(before.cameraBobRight);
    expect(paused.cameraBobUp).toBeCloseTo(before.cameraBobUp);
  });

  it("reaches the same phase for the same recorded time across render cadences", () => {
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
    expect(fineResult.cameraBobRight).toBeCloseTo(coarseResult.cameraBobRight);
    expect(fineResult.cameraBobUp).toBeCloseTo(coarseResult.cameraBobUp);
    expect(fineResult.cameraPitchDegrees).toBeCloseTo(coarseResult.cameraPitchDegrees);
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
    expect(landed.cameraBobRight).toBe(0);
    expect(landed.cameraBobUp).toBe(0);
  });
});
