import type { QueuedInput } from "@shared/server/simulation/components/InputComponent";
import { describe, expect, it } from "vitest";
import type { RecordedCmd, ReSimSpawn } from "../ReSim";
import { buildBundle, decodeBundle, encodeBundle, verifyBundle } from "../ReSimBundle";

const spawns: ReSimSpawn[] = [{ entityId: 1, playerId: 1, x: 0, y: 500, z: 0 }];

function cmd(seq: number, o: Partial<QueuedInput> = {}): QueuedInput {
  return { forward: 0, right: 0, pitch: 0, yaw: 0, buttons: 0, sequence: seq, weaponSlot: 0, ...o };
}

function makeLog(): RecordedCmd[] {
  const log: RecordedCmd[] = [];
  for (let t = 0; t < 60; t++) {
    log.push({ tick: t, entityId: 1, cmd: cmd(t + 1, { forward: 1, right: t % 2 === 0 ? 1 : -1, yaw: t * 0.05 }) });
  }
  return log;
}

describe("ReSimBundle — on-disk re-sim artifact (WO-AC4b)", () => {
  it("round-trips through encode/decode", () => {
    const b = buildBundle(spawns, makeLog(), 60);
    const back = decodeBundle(encodeBundle(b));
    expect(back.tickRate).toBe(b.tickRate);
    expect(back.ticks).toBe(b.ticks);
    expect(back.spawns).toEqual(b.spawns);
    expect(back.golden).toEqual(b.golden);
    expect(back.log.length).toBe(b.log.length);
    // spot-check a command survives the float round-trip
    expect(back.log[30].cmd.yaw).toBeCloseTo(b.log[30].cmd.yaw, 4);
    expect(back.log[30].cmd.right).toBe(b.log[30].cmd.right);
  });

  it("verifies a clean bundle end-to-end", () => {
    const bytes = encodeBundle(buildBundle(spawns, makeLog(), 60));
    const v = verifyBundle(bytes);
    expect(v.ok).toBe(true);
    expect(v.divergedAtTick).toBeNull();
  });

  it("detects a doctored golden checksum in the bundle", () => {
    const b = buildBundle(spawns, makeLog(), 60);
    b.golden[20] = (b.golden[20] ^ 0xbeef) >>> 0;
    const v = verifyBundle(encodeBundle(b));
    expect(v.ok).toBe(false);
    expect(v.divergedAtTick).toBe(20);
  });

  it("detects a tampered usercmd log (golden no longer reproduces)", () => {
    const b = buildBundle(spawns, makeLog(), 60);
    // Change one input but keep the original golden checksums.
    b.log[30] = { ...b.log[30], cmd: { ...b.log[30].cmd, right: 0 } };
    const v = verifyBundle(encodeBundle(b));
    expect(v.ok).toBe(false);
    expect(v.divergedAtTick!).toBeGreaterThanOrEqual(30);
  });

  it("rejects non-bundle bytes", () => {
    expect(() => decodeBundle(new Uint8Array([1, 2, 3, 4, 5]))).toThrow();
  });
});
