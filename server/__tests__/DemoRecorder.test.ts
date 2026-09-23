/**
 * DemoRecorder min-duration guard — only real matches are kept.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GameState } from "../../../../engine/network/core/GameState";
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
  });

  it("round-trips a verified match and roster without changing frame access", async () => {
    const rec = new DemoRecorder({ ...base, matchId: "match-verified", minDurationMs: 0 });
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
      version: 3,
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

  it("discards an empty recording", async () => {
    const rec = new DemoRecorder({ ...base, minDurationMs: 0 });
    const fp = await rec.stop();
    expect(fp).toBe("");
  });
});
