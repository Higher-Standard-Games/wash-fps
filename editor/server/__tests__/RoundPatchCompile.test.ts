import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyOperations, emptyDocument } from "../../../../../engine/editor/api/Operations";
import { writeMap } from "../../../../../engine/editor/MapWriter";
import { CompileJobs } from "../../../../../engine/editor/server/CompileJobs";
import { resolveCompilerConfig } from "../../../../../engine/editor/server/CompilerConfig";
import { clearGameCompilerProfile } from "../../../../../engine/editor/server/GameCompilerProfile";
import { MapStore } from "../../../../../engine/editor/server/MapStore";
import { BspLoader } from "../../../../../engine/loader/bsp/BspLoader";
import { resolveMapBspViaIndex } from "../../../../../engine/loader/pk3/NodePk3";
import { SweepCollisionBackend } from "../../../../../engine/physics/SweepCollisionBackend";
import { registerFpsCompilerProfile } from "../FpsCompilerProfile";

beforeEach(registerFpsCompilerProfile);
afterEach(clearGameCompilerProfile);

/** A shipped, drawn texture (256x256): new geometry is caulk unless textured. */
const VISIBLE = "cleansurface/pantonecoolgray10c";

it("compiles round presets with finite draw data, closed tops and a hollow tube passage", async () => {
  const compiler = await resolveCompilerConfig();
  if (!compiler.available) return;
  const root = await mkdtemp(path.join(tmpdir(), "shagged-round-"));
  try {
    const doc = applyOperations(emptyDocument("roundprobe"), [
      { op: "gen.room", id: "room", min: { x: -256, y: -256, z: 0 }, max: { x: 256, y: 256, z: 192 }, shader: VISIBLE },
      { op: "entity.place", classname: "info_player_deathmatch", origin: { x: 0, y: -200, z: 48 } },
      {
        op: "patch.round",
        shader: VISIBLE,
        id: "cylinder",
        shape: "cylinder",
        min: { x: -48, y: -48, z: 0 },
        max: { x: 48, y: 48, z: 96 },
      },
      {
        op: "patch.round",
        shader: VISIBLE,
        id: "tube",
        shape: "tube",
        min: { x: -160, y: -32, z: 0 },
        max: { x: -96, y: 32, z: 96 },
        thickness: 8,
      },
      {
        op: "patch.round",
        shader: VISIBLE,
        id: "cone",
        shape: "cone",
        min: { x: 96, y: -32, z: 0 },
        max: { x: 160, y: 32, z: 96 },
      },
      {
        op: "patch.round",
        shader: VISIBLE,
        id: "cap",
        shape: "cap",
        min: { x: -32, y: -160, z: 32 },
        max: { x: 32, y: -96, z: 32 },
      },
    ]).doc;
    const store = new MapStore(path.join(root, "maps"));
    await store.init();
    const saved = await store.save("roundprobe", writeMap(doc), 0, doc),
      data = path.join(root, "data");
    const jobs = new CompileJobs(store, compiler, path.join(root, "jobs"), undefined, data),
      requested = await jobs.request("roundprobe", saved.revision, "fast"),
      completed = await jobs.wait(requested.id);
    expect(completed?.state, completed?.logs.join("\n")).toBe("playable");
    const bsp = BspLoader.load((await resolveMapBspViaIndex([data], "roundprobe"))!);
    expect(
      bsp.vertices.every((vertex) => [...vertex.position, ...vertex.normal, ...vertex.texCoord].every(Number.isFinite)),
    ).toBe(true);
    const collision = new SweepCollisionBackend();
    await collision.init(bsp);
    const down = (x: number, y: number) =>
      collision.trace(new Vector3(x, 160, y), new Vector3(x, 16, y), { radius: 1, height: 2 });
    expect(down(8, 3).endPos.y).toBeCloseTo(96.75, 0);
    expect(down(-100, 3).endPos.y).toBeCloseTo(96.75, 0);
    expect(down(-128, 0).fraction).toBe(1);
    expect(down(136, 3).endPos.y).toBeGreaterThan(64);
    expect(down(136, 3).endPos.y).toBeLessThan(97);
    expect(down(8, -125).endPos.y).toBeCloseTo(32.75, 0);
    const side = collision.trace(new Vector3(-80, 48, 0), new Vector3(80, 48, 0), { radius: 1, height: 2 });
    expect(side.endPos.x).toBeCloseTo(-49, 0);
    const pointDown = (x: number, y: number) =>
      collision.trace(new Vector3(x, 160, y), new Vector3(x, 16, y), { radius: 0, height: 0 });
    for (const [x, y, height] of [
      [0, 0, 96],
      [8, 3, 96],
      [-100, 3, 96],
      [0, -128, 32],
    ]) {
      const hit = pointDown(x, y);
      expect(hit.fraction).toBeLessThan(1);
      expect(hit.endPos.y).toBeCloseTo(height + 0.03125, 4);
      expect(hit.normal?.y).toBeCloseTo(1, 5);
    }
    expect(pointDown(-128, 0).fraction).toBe(1);
    expect(pointDown(49, 0).fraction).toBe(1);
    const pointSide = collision.trace(new Vector3(-80, 48, 0), new Vector3(80, 48, 0), { radius: 0, height: 0 });
    expect(pointSide.fraction).toBeLessThan(1);
    expect(pointSide.endPos.x).toBeCloseTo(-48.03125, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
