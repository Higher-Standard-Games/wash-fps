/**
 * DemoRecorder min-duration guard — only real matches are kept.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { GameState } from "../../../../engine/network/core/GameState";
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

  it("discards an empty recording", async () => {
    const rec = new DemoRecorder({ ...base, minDurationMs: 0 });
    const fp = await rec.stop();
    expect(fp).toBe("");
  });
});
