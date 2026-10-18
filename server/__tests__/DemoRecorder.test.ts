/**
 * DemoRecorder min-duration guard — only real matches are kept.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GameState } from "../../../../engine/network/core/GameState";
import { BinaryEncoder, BinaryProtocol } from "../../../../engine/network/protocol/BinaryProtocol";
import { DemoReader } from "../../../../shared/demo/DemoReader";
import { DemoRecorder } from "../DemoRecorder";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shagdemo-test-"));
const written: string[] = [];

afterEach(() => {
  for (const f of written) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
  written.length = 0;
});

function frame(tick: number): GameState {
  const s = new GameState();
  s.tick = tick;
  return s;
}

const base = { map: "wdm7", gametype: "duel", tickRate: 125, snapshotRate: 60, outputDir: tmpDir };

describe("DemoRecorder min-duration guard", () => {
  it("discards a match shorter than the minimum duration (default)", async () => {
    const rec = new DemoRecorder(base); // default 10s floor; this test records ~0ms
    rec.recordFrame(frame(1));
    rec.recordFrame(frame(2));
    const fp = await rec.stop();
    expect(fp).toBe("");
  });

  it("writes a demo when the match meets the minimum (minDurationMs override)", async () => {
    const rec = new DemoRecorder({ ...base, minDurationMs: 0 });
    rec.recordFrame(frame(1));
    rec.recordFrame(frame(2));
    const fp = await rec.stop();
    written.push(fp);
    expect(fp).not.toBe("");
    expect(fs.existsSync(fp)).toBe(true);
    expect(new DemoReader(new Uint8Array(fs.readFileSync(fp))).readHeader().private).toBe(false);
  });

  it("round-trips a verified match and roster without changing frame access", async () => {
    const rec = new DemoRecorder({ ...base, matchId: "match-verified", private: true, minDurationMs: 0 });
    rec.addPlayer("1", "One", "", 41);
    rec.addPlayer("2", "Two", "", 42);
    rec.addPlayer("3", "Bot", "");
    // Commands the server applied between snapshots: buttons fold together so a
    // press that falls between two frames is not lost, and the analogue fields
    // keep the value they ended on.
    rec.recordInput("1", { buttons: 0b0001, yaw: 0.5, pitch: 0, forward: 1, right: 0, weaponSlot: 2 });
    rec.recordInput("1", { buttons: 0b0010, yaw: 0.75, pitch: -0.25, forward: 1, right: 1, weaponSlot: 2 });
    rec.recordFrame(frame(1));
    rec.recordFrame(frame(2));
    const fp = await rec.stop();
    written.push(fp);
    const reader = new DemoReader(new Uint8Array(fs.readFileSync(fp)));
    expect(reader.readHeader()).toMatchObject({
      version: 6,
      private: true,
      matchId: "match-verified",
      players: [
        { playerId: "1", accountId: 41 },
        { playerId: "2", accountId: 42 },
        { playerId: "3", name: "Bot" },
      ],
    });
    expect(reader.readHeader().players[2].accountId).toBeUndefined();
    const frames = reader.readAllFrames();
    expect(frames.map((entry) => entry.tick)).toEqual([1, 2]);

    // The first frame carries both commands, folded into one record
    expect(frames[0].inputs).toEqual([
      {
        playerId: "1",
        buttons: 0b0011,
        yaw: 0.75,
        pitch: -0.25,
        forward: 1,
        right: 1,
        weaponSlot: 2,
        commands: 2,
      },
    ]);
    // …and the second has none, because nothing was pressed after the flush
    expect(frames[1].inputs).toEqual([]);
  });

  it("records persistent brush state in a v6 frame", async () => {
    const rec = new DemoRecorder({ ...base, minDurationMs: 0 });
    const state = frame(125);
    state.events.push({
      type: "match_state",
      objective: { kind: "bomb", phase: "detonated", disabledModels: [5, 6] },
    } as never);
    rec.recordFrame(state);
    const file = await rec.stop();
    written.push(file);
    const reader = new DemoReader(new Uint8Array(fs.readFileSync(file)));
    expect(reader.readHeader().version).toBe(6);
    expect(reader.readAllFrames()[0].state.events[0]).toMatchObject({ objective: { disabledModels: [5, 6] } });
  });

  it("never overwrites a demo that finished in the same second", async () => {
    // The filename is accurate to a second, and a lobby starting two rooms at
    // once means two matches can end inside one. Both recordings are worth
    // keeping; the second used to replace the first with nothing said.
    const first = new DemoRecorder({ ...base, minDurationMs: 0 });
    first.recordFrame(frame(1));
    const firstPath = await first.stop();
    written.push(firstPath);

    const second = new DemoRecorder({ ...base, minDurationMs: 0 });
    second.recordFrame(frame(2));
    const secondPath = await second.stop();
    written.push(secondPath);

    expect(secondPath).not.toBe(firstPath);
    expect(fs.existsSync(firstPath)).toBe(true);
    expect(fs.existsSync(secondPath)).toBe(true);
    expect(new DemoReader(new Uint8Array(fs.readFileSync(firstPath))).readAllFrames()[0].tick).toBe(1);
    expect(new DemoReader(new Uint8Array(fs.readFileSync(secondPath))).readAllFrames()[0].tick).toBe(2);
  });

  it("still reads the version 1 header layout", () => {
    const bytes: number[] = [0x53, 0x48, 0x41, 0x47, 1];
    const string = (value: string) => {
      const data = new TextEncoder().encode(value);
      bytes.push(data.length & 255, data.length >> 8, ...data);
    };
    string("wdm2");
    string("duel");
    bytes.push(125, 63, 0, 0, 0, 0, 0, 0, 0, 0, 1);
    string("1");
    string("Legacy");
    string("");
    expect(new DemoReader(new Uint8Array(bytes)).readHeader()).toMatchObject({
      version: 1,
      map: "wdm2",
      gametype: "duel",
      players: [{ playerId: "1", name: "Legacy" }],
    });
  });

  it.each([2, 3])("still seeks version %i frames with verified roster and no visibility byte", (version) => {
    const encoder = new BinaryEncoder();
    for (const byte of [0x53, 0x48, 0x41, 0x47, version]) encoder.writeUint8(byte);
    encoder.writeString("wdm2");
    encoder.writeString("duel");
    encoder.writeUint8(125);
    encoder.writeUint8(63);
    encoder.writeUint32(0);
    encoder.writeUint32(1000);
    encoder.writeString("legacy-match");
    encoder.writeUint8(1);
    for (const value of ["1", "Legacy", "", "41"]) encoder.writeString(value);
    const frameOffset = encoder.toBytes().length;
    const snapshot = BinaryProtocol.encodeSnapshot(frame(125));
    encoder.writeUint32(125);
    encoder.writeUint32(snapshot.length);
    for (const byte of snapshot) encoder.writeUint8(byte);
    if (version >= 3) encoder.writeUint32(0);
    const indexOffset = encoder.toBytes().length;
    encoder.writeUint32(1);
    encoder.writeUint32(125);
    encoder.writeUint32(frameOffset);
    encoder.writeUint32(1000);
    encoder.writeUint32(indexOffset);
    const reader = new DemoReader(encoder.toBytes());
    expect(reader.readHeader()).toMatchObject({ version, matchId: "legacy-match", players: [{ accountId: 41 }] });
    expect(reader.readHeader().private).toBeUndefined();
    expect(reader.readFrame(0)).toMatchObject({ tick: 125, inputs: [] });
  });

  it("discards an empty recording", async () => {
    const rec = new DemoRecorder({ ...base, minDurationMs: 0 });
    const fp = await rec.stop();
    expect(fp).toBe("");
  });
});

describe("DemoRecorder file naming", () => {
  it("writes a named demo, and never over an existing one", async () => {
    const first = new DemoRecorder({ ...base, minDurationMs: 0, fileName: "wdm2_ra" });
    first.recordFrame(frame(1));
    const a = await first.stop();
    written.push(a);
    const second = new DemoRecorder({ ...base, minDurationMs: 0, fileName: "wdm2_ra" });
    second.recordFrame(frame(1));
    const b = await second.stop();
    written.push(b);
    expect(path.basename(a)).toBe("wdm2_ra.shagdemo");
    expect(path.basename(b)).toBe("wdm2_ra_2.shagdemo");
  });

  it("strips anything but letters, digits, _ and - from the name", async () => {
    const rec = new DemoRecorder({ ...base, minDurationMs: 0, fileName: "../wdm2 ra" });
    rec.recordFrame(frame(1));
    const fp = await rec.stop();
    written.push(fp);
    expect(path.dirname(fp)).toBe(tmpDir);
    expect(path.basename(fp)).toBe("___wdm2_ra.shagdemo");
  });
});
