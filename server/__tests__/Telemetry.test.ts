import { playerId } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
import { angularDeltaDeg, FLICK_SPEED_BUCKETS_DPS, Telemetry, updateJitter } from "../Telemetry";

const P = playerId(1);

describe("angularDeltaDeg", () => {
  it("is zero for equal angles", () => {
    expect(angularDeltaDeg(1.23, 1.23)).toBeCloseTo(0, 6);
  });

  it("takes the shortest way around the circle (wrap)", () => {
    // 10° short of a full turn should read as 10°, not 350°.
    const tenDeg = (10 * Math.PI) / 180;
    expect(angularDeltaDeg(0, Math.PI * 2 - tenDeg)).toBeCloseTo(10, 4);
    expect(angularDeltaDeg(-Math.PI + 0.01, Math.PI - 0.01)).toBeCloseTo((0.02 * 180) / Math.PI, 4);
  });
});

describe("updateJitter (RFC3550)", () => {
  it("stays 0 when inter-arrival is perfectly regular", () => {
    let j = 0;
    for (let i = 0; i < 50; i++) j = updateJitter(j, 8, 8); // every 8ms, no variance
    expect(j).toBeCloseTo(0, 6);
  });

  it("rises with irregular inter-arrival and relaxes back down", () => {
    let j = 0;
    j = updateJitter(j, 40, 8); // a 32ms swing
    expect(j).toBeGreaterThan(0);
    const spiked = j;
    for (let i = 0; i < 100; i++) j = updateJitter(j, 8, 8); // steady again
    expect(j).toBeLessThan(spiked);
    expect(j).toBeCloseTo(0, 2);
  });
});

describe("Telemetry", () => {
  it("returns null for an untracked client and after removal", () => {
    const t = new Telemetry();
    expect(t.get(P)).toBeNull();
    t.add(P);
    t.recordInput(P, 1000, 1, 0, 0);
    expect(t.get(P)).not.toBeNull();
    t.remove(P);
    expect(t.get(P)).toBeNull();
  });

  it("reports zero input loss for a gapless sequence", () => {
    const t = new Telemetry();
    t.add(P);
    for (let seq = 1; seq <= 10; seq++) t.recordInput(P, 1000 + seq * 8, seq, 0, 0);
    expect(t.get(P)!.inputLoss).toBeCloseTo(0, 6);
    expect(t.get(P)!.inputs).toBe(10);
  });

  it("measures input loss from sequence gaps", () => {
    const t = new Telemetry();
    t.add(P);
    // seqs 1,2,4,5 → 3 was never received: span 5, received 4 → 20% loss.
    let ms = 1000;
    for (const seq of [1, 2, 4, 5]) {
      ms += 8;
      t.recordInput(P, ms, seq, 0, 0);
    }
    expect(t.get(P)!.inputLoss).toBeCloseTo(0.2, 6);
  });

  it("stays ~0 jitter for a steady stream and spikes on an irregular gap", () => {
    const t = new Telemetry();
    t.add(P);
    let ms = 1000;
    for (let seq = 1; seq <= 20; seq++) {
      ms += 8;
      t.recordInput(P, ms, seq, 0, 0);
    }
    const steady = t.get(P)!.jitterMs;
    expect(steady).toBeCloseTo(0, 1);

    ms += 120; // a big late gap
    t.recordInput(P, ms, 21, 0, 0);
    expect(t.get(P)!.jitterMs).toBeGreaterThan(steady);
  });

  it("counts input-contract violations (rejected / clamped), zero by default", () => {
    const t = new Telemetry();
    t.add(P);
    let m = t.get(P)!;
    expect(m.rejectedCmds).toBe(0);
    expect(m.clampedCmds).toBe(0);

    t.recordViolation(P, "rejected");
    t.recordViolation(P, "rejected");
    t.recordViolation(P, "clamped");
    m = t.get(P)!;
    expect(m.rejectedCmds).toBe(2);
    expect(m.clampedCmds).toBe(1);

    // untracked player is a silent no-op (no throw)
    t.recordViolation(playerId(999), "rejected");
  });

  it("measures view angular speed and tracks the peak flick", () => {
    const t = new Telemetry();
    t.add(P);
    t.recordInput(P, 1000, 1, 0, 0);
    // 90° yaw flick in 8ms → 11250 deg/s.
    t.recordInput(P, 1008, 2, 0, Math.PI / 2);
    const m = t.get(P)!;
    expect(m.peakViewSpeedDps).toBeCloseTo(11250, 0);
    expect(m.viewSpeedDps).toBeGreaterThan(0);

    // A long still period drags the EWMA down but leaves the peak.
    let ms = 1008;
    for (let seq = 3; seq < 60; seq++) {
      ms += 8;
      t.recordInput(P, ms, seq, 0, Math.PI / 2);
    }
    const after = t.get(P)!;
    expect(after.viewSpeedDps).toBeLessThan(m.viewSpeedDps);
    expect(after.peakViewSpeedDps).toBeCloseTo(11250, 0);
  });
  it("does not bucket the first input because no speed sample exists yet", () => {
    const t = new Telemetry();
    t.add(P);
    t.recordInput(P, 1000, 1, 0, 0);

    expect(t.get(P)!.flickHistogram).toEqual(new Array(FLICK_SPEED_BUCKETS_DPS.length).fill(0));
  });

  it("buckets steady low-speed aim into the lowest flick bucket", () => {
    const t = new Telemetry();
    t.add(P);
    t.recordInput(P, 1000, 1, 0, 0);
    t.recordInput(P, 2000, 2, 0, Math.PI / 180); // 1 deg/s

    const hist = t.get(P)!.flickHistogram;
    expect(hist[0]).toBe(1);
    expect(hist.reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it("buckets a 90 degree / 8ms flick into the <=11520 dps bucket", () => {
    const t = new Telemetry();
    t.add(P);
    t.recordInput(P, 1000, 1, 0, 0);
    t.recordInput(P, 1008, 2, 0, Math.PI / 2);

    const hist = t.get(P)!.flickHistogram;
    const bucket = FLICK_SPEED_BUCKETS_DPS.indexOf(11520);
    expect(hist[bucket]).toBe(1);
    expect(hist.reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it("buckets yaw wraparound using the shortest angular path", () => {
    const t = new Telemetry();
    t.add(P);
    const tenDeg = (10 * Math.PI) / 180;
    t.recordInput(P, 1000, 1, 0, Math.PI * 2 - tenDeg);
    t.recordInput(P, 2000, 2, 0, 0);

    const m = t.get(P)!;
    expect(m.peakViewSpeedDps).toBeCloseTo(10, 4);
    expect(m.flickHistogram[0]).toBe(1);
  });

  it("returns a defensive copy of the flick histogram", () => {
    const t = new Telemetry();
    t.add(P);
    t.recordInput(P, 1000, 1, 0, 0);
    t.recordInput(P, 2000, 2, 0, Math.PI / 180);

    const first = t.get(P)!.flickHistogram as number[];
    first[0] = 999;

    expect(t.get(P)!.flickHistogram[0]).toBe(1);
  });
});
