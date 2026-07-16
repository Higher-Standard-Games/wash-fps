/**
 * ServerTiming contract (QA-24 / QA-WO12).
 *
 * Locks the one timing value everything derives from: snapshot cadence is an
 * integer tick divisor whose EFFECTIVE rate is what gets reported (recording
 * the requested 60 at 125Hz — actually 62.5Hz — made demo playback ~4.17%
 * slow); lifecycle timers scale with the tick rate instead of hardcoding
 * `10 * 125`; and subsystems declare tickRate 0 (every base tick) so a
 * non-default base rate can no longer starve them (the old accumulator ran a
 * "125Hz" subsystem at most once per base tick — at base 60 that simulated
 * 8ms per 16.7ms of wall time, half-speed physics).
 */

import { Simulation } from "@engine/server/core/Simulation";
import { Subsystem } from "@engine/server/core/Subsystem";
import type { WorldState } from "@engine/server/core/WorldState";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerTiming, secondsToTicks } from "../ServerTiming";
import { CharacterPhysicsSystem } from "../systems/CharacterPhysicsSystem";
import { CombatSystem } from "../systems/CombatSystem";
import { DroppedWeaponSystem } from "../systems/DroppedWeaponSystem";
import { FPSMovementSubsystem } from "../systems/FPSMovementSubsystem";
import { PickupSystem } from "../systems/PickupSystem";
import { ProjectileSystem } from "../systems/ProjectileSystem";
import { WeaponSystem } from "../systems/WeaponSystem";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createServerTiming", () => {
  it("derives the default 125/60 operating point with the honest effective rate", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = createServerTiming({ tickRate: 125, snapshotRate: 60 });
    expect(t.tickMs).toBe(8);
    expect(t.tickDt).toBe(1 / 125);
    expect(t.ticksPerSnapshot).toBe(2); // round(125/60)
    expect(t.effectiveSnapshotRate).toBe(62.5); // NOT the requested 60
    expect(t.requestedSnapshotRate).toBe(60);
    expect(warn).toHaveBeenCalledOnce(); // requested != effective is called out
  });

  it("is silent when the snapshot rate divides the tick rate", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = createServerTiming({ tickRate: 125, snapshotRate: 25 });
    expect(t.ticksPerSnapshot).toBe(5);
    expect(t.effectiveSnapshotRate).toBe(25);
    expect(warn).not.toHaveBeenCalled();
  });

  it("scales lifecycle timers with the tick rate (no 10*125 literals)", () => {
    const at125 = createServerTiming({ tickRate: 125 });
    expect(at125.postGameBotKickTicks).toBe(10 * 125);
    expect(at125.postGameGraceTicks).toBe(120 * 125);

    vi.spyOn(console, "warn").mockImplementation(() => {});
    const at100 = createServerTiming({ tickRate: 100 });
    expect(at100.postGameBotKickTicks).toBe(10 * 100);
    expect(at100.postGameGraceTicks).toBe(120 * 100);
  });

  it("rejects unrepresentable configs", () => {
    expect(() => createServerTiming({ tickRate: 0 })).toThrow(/positive integer/);
    expect(() => createServerTiming({ tickRate: 62.5 })).toThrow(/positive integer/);
    expect(() => createServerTiming({ tickRate: 125, snapshotRate: 0 })).toThrow(/> 0/);
    expect(() => createServerTiming({ tickRate: 125, snapshotRate: 250 })).toThrow(/cannot exceed/);
  });

  it("secondsToTicks rounds to whole ticks", () => {
    expect(secondsToTicks(10, 125)).toBe(1250);
    expect(secondsToTicks(0.5, 125)).toBe(63);
  });
});

describe("subsystem base-rate contract", () => {
  it("every fps subsystem declares tickRate 0 (follows the base rate)", () => {
    const subsystems = [
      new FPSMovementSubsystem(),
      new CharacterPhysicsSystem(),
      new ProjectileSystem(),
      new WeaponSystem(),
      new CombatSystem(),
      new PickupSystem(),
      new DroppedWeaponSystem(),
    ];
    for (const s of subsystems) {
      expect(s.tickRate, `${s.name} must follow the base tick rate`).toBe(0);
    }
  });

  it("a base rate below 125 no longer starves subsystems (full dt every tick)", () => {
    // The regression this guards: a subsystem declaring tickRate 125 under a
    // 60Hz base ran once per base tick with dt=1/125 — simulating 8ms per
    // 16.7ms of wall time. With tickRate 0 it gets the base dt every tick.
    class Probe extends Subsystem {
      updates = 0;
      simulatedSeconds = 0;
      constructor() {
        super({ name: "Probe", priority: 1, tickRate: 0 });
      }
      update(_state: WorldState, dt: number): void {
        this.updates++;
        this.simulatedSeconds += dt;
      }
    }
    const probe = new Probe();
    const sim = new Simulation({ tickMs: 1000 / 60 }); // 60Hz base
    sim.addSubsystem(probe);
    sim.runTicks(60); // one second of wall time

    expect(probe.updates).toBe(60);
    expect(probe.simulatedSeconds).toBeCloseTo(1.0, 6); // full second, not 60/125ths
  });
});
