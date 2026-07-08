/**
 * Re-sim bundle — the on-disk artifact for deterministic demo verification
 * (anti-cheat WO-AC4b).
 *
 * Carries everything the re-sim oracle (`ReSim.ts`) needs to reproduce and check
 * a recorded run: initial spawns, the tick-tagged usercmd log, and the **golden
 * per-tick state checksums** produced when it was recorded. `demo:verify` reads a
 * bundle, replays the usercmds, and confirms the checksums reconcile — tamper-
 * evident, self-contained, no live server needed.
 *
 * Scope note: this is the movement-scope oracle's artifact (see `ReSim.ts`).
 * Verifying a full `.shagdemo` match additionally requires full-server re-sim
 * (all subsystems + collision + event replay) — a larger, separate extension.
 * The bundle format is deliberately independent of `.shagdemo` so the two evolve
 * separately.
 */

import { BinaryDecoder, BinaryEncoder } from "../../../engine/network/protocol/BinaryProtocol";
import type { RecordedCmd, ReSimResult, ReSimSpawn } from "./ReSim";
import { resimulate, type VerifyResult, verifyAgainst } from "./ReSim";

const zlib = require("node:zlib") as typeof import("node:zlib");

/** Magic "SHVR" (SHag VeRify). */
const BUNDLE_MAGIC = [0x53, 0x48, 0x56, 0x52];
const BUNDLE_VERSION = 1;

export interface ReSimBundle {
  tickRate: number;
  ticks: number;
  spawns: ReSimSpawn[];
  log: RecordedCmd[];
  /** Golden per-tick checksum series (length === ticks). */
  golden: number[];
}

/** Run the oracle to produce a bundle from a recorded run (golden = re-sim output). */
export function buildBundle(spawns: ReSimSpawn[], log: RecordedCmd[], ticks: number, tickRate = 125): ReSimBundle {
  const result: ReSimResult = resimulate(spawns, log, ticks);
  return { tickRate, ticks, spawns, log, golden: result.perTickChecksum };
}

/** Serialize a bundle to gzipped binary. */
export function encodeBundle(b: ReSimBundle): Uint8Array {
  const enc = new BinaryEncoder(64 * 1024);
  for (const byte of BUNDLE_MAGIC) enc.writeUint8(byte);
  enc.writeUint8(BUNDLE_VERSION);
  enc.writeUint8(b.tickRate);
  enc.writeUint32(b.ticks);

  enc.writeUint16(b.spawns.length);
  for (const s of b.spawns) {
    enc.writeUint32(s.entityId);
    enc.writeUint32(s.playerId);
    enc.writeFloat32(s.x);
    enc.writeFloat32(s.y);
    enc.writeFloat32(s.z);
  }

  enc.writeUint32(b.log.length);
  for (const { tick, entityId, cmd } of b.log) {
    enc.writeUint32(tick);
    enc.writeUint32(entityId);
    enc.writeFloat32(cmd.forward);
    enc.writeFloat32(cmd.right);
    enc.writeFloat32(cmd.pitch);
    enc.writeFloat32(cmd.yaw);
    enc.writeUint16(cmd.buttons);
    enc.writeUint32(cmd.sequence);
    enc.writeUint8(cmd.weaponSlot);
  }

  enc.writeUint32(b.golden.length);
  for (const c of b.golden) enc.writeUint32(c >>> 0);

  return zlib.gzipSync(enc.getData(), { level: 6 });
}

/** Parse a gzipped bundle. Throws on bad magic / unsupported version. */
export function decodeBundle(data: Uint8Array): ReSimBundle {
  const raw = data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b ? new Uint8Array(zlib.gunzipSync(data)) : data;
  const dec = new BinaryDecoder(raw);

  for (let i = 0; i < 4; i++) {
    if (dec.readUint8() !== BUNDLE_MAGIC[i]) throw new Error("Not a re-sim bundle (bad magic)");
  }
  const version = dec.readUint8();
  if (version !== BUNDLE_VERSION) throw new Error(`Unsupported bundle version: ${version}`);
  const tickRate = dec.readUint8();
  const ticks = dec.readUint32();

  const spawnCount = dec.readUint16();
  const spawns: ReSimSpawn[] = [];
  for (let i = 0; i < spawnCount; i++) {
    spawns.push({
      entityId: dec.readUint32(),
      playerId: dec.readUint32(),
      x: dec.readFloat32(),
      y: dec.readFloat32(),
      z: dec.readFloat32(),
    });
  }

  const logCount = dec.readUint32();
  const log: RecordedCmd[] = [];
  for (let i = 0; i < logCount; i++) {
    const tick = dec.readUint32();
    const entityId = dec.readUint32();
    log.push({
      tick,
      entityId,
      cmd: {
        forward: dec.readFloat32(),
        right: dec.readFloat32(),
        pitch: dec.readFloat32(),
        yaw: dec.readFloat32(),
        buttons: dec.readUint16(),
        sequence: dec.readUint32(),
        weaponSlot: dec.readUint8(),
      },
    });
  }

  const goldenCount = dec.readUint32();
  const golden: number[] = [];
  for (let i = 0; i < goldenCount; i++) golden.push(dec.readUint32());

  return { tickRate, ticks, spawns, log, golden };
}

/** Verify a serialized bundle: re-sim its usercmds and reconcile against its golden checksums. */
export function verifyBundle(data: Uint8Array): VerifyResult {
  const b = decodeBundle(data);
  return verifyAgainst(b.spawns, b.log, b.golden);
}
