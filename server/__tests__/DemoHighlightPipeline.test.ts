/**
 * End-to-end highlights pipeline: record → read → analyze.
 *
 * Proves that combat events (death/award/combat_state) and player entity state
 * survive the real DemoRecorder binary format and that DemoAnalyzer can score a
 * highlight from a recorded .shagdemo. This is the foundation of the automatic
 * highlight-reel feature — and the exact path that produced NO highlights before
 * the recording fix (events were drained before recording).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { Entity } from "../../../../engine/network/core/Entity";
import { GameState } from "../../../../engine/network/core/GameState";
import { DemoAnalyzer } from "../../../../shared/demo/DemoAnalyzer";
import { DemoReader } from "../../../../shared/demo/DemoReader";
import { DemoRecorder } from "../DemoRecorder";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shagdemo-hl-"));
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

const noop = () => {};

function playerEntity(
  id: string,
  pos: { x: number; y: number; z: number },
  vel: { x: number; y: number; z: number },
  grounded: boolean,
): Entity {
  const e = new Entity(id);
  e.addComponent("transform", {
    position: { ...pos },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    serialize: noop,
    deserialize: noop,
    clone() {
      return { ...this };
    },
  });
  e.addComponent("velocity", {
    x: vel.x,
    y: vel.y,
    z: vel.z,
    linear: { ...vel },
    grounded,
    serialize: noop,
    deserialize: noop,
    clone() {
      return { ...this };
    },
  });
  return e;
}

/** A frame with the given tick, the two players, and optional events. */
function frame(tick: number, events: Array<Record<string, unknown>>, killerAirborne: boolean): GameState {
  const s = new GameState();
  s.tick = tick;
  // Killer at height, moving fast upward (rocket-jump) and airborne on the kill.
  s.entities.set(
    "player_1",
    playerEntity("player_1", { x: 0, y: 200, z: 0 }, { x: 0, y: 220, z: 0 }, !killerAirborne),
  );
  s.entities.set("player_2", playerEntity("player_2", { x: 2000, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, true));
  s.events = events as GameState["events"];
  return s;
}

describe("Demo highlights pipeline (record → read → analyze)", () => {
  it("scores a rocket-jump frag from a recorded demo", async () => {
    const rec = new DemoRecorder({
      map: "wdm7",
      gametype: "duel",
      tickRate: 125,
      snapshotRate: 60,
      outputDir: tmpDir,
      minDurationMs: 0, // keep this short synthetic match
    });
    rec.addPlayer("1", "Killer", "");
    rec.addPlayer("2", "Victim", "");

    // Lead-in frames, the kill, then follow-through — enough for the analyzer's
    // context windows. The death event carries victim pos; killer pos/velocity
    // come from the killer entity (airborne + long range → tags).
    const KILL_TICK = 300;
    for (let i = 0; i < 12; i++) {
      const tick = KILL_TICK - 60 + i * 12;
      const isKill = tick === KILL_TICK;
      const events: Array<Record<string, unknown>> = [
        { type: "combat_state", entityId: "player_1", health: 45, armor: 0, dead: false },
      ];
      if (isKill) {
        events.push({
          type: "death",
          entityId: "player_2",
          killerId: "player_1",
          weaponId: "rocketlauncher",
          damageType: "Explosion",
          finalDamage: 120,
          x: 2000,
          y: 0,
          z: 0,
        });
      }
      rec.recordFrame(frame(tick, events, isKill));
    }

    const filepath = await rec.stop();
    written.push(filepath);
    expect(filepath).not.toBe("");

    // Read it back through the real file format (gzip + index + binary snapshots).
    const reader = new DemoReader(new Uint8Array(fs.readFileSync(filepath)));
    const header = reader.readHeader();
    const index = reader.readIndex();
    const frames = reader.readAllFrames();

    expect(header.map).toBe("wdm7");
    expect(frames.length).toBe(12);

    // Analyze for highlights.
    const analysis = new DemoAnalyzer().analyze(frames, header, index.durationMs);
    expect(analysis.highlights.length).toBeGreaterThanOrEqual(1);

    const h = analysis.highlights[0];
    expect(h.primaryPlayer).toBe("player_1");
    expect(h.primaryPlayerName).toBe("Killer");
    expect(h.victimPlayer).toBe("player_2");
    expect(h.victimPlayerName).toBe("Victim");
    expect(h.weaponId).toBe("rocketlauncher");
    expect(h.score).toBeGreaterThan(0);
    // Killer was airborne with high upward velocity + far from victim.
    expect(h.tags).toContain("rocket_jump");
    expect(h.tags).toContain("long_range");
    expect(h.type).toBe("airborne_frag");
  });
});
