import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyOperations, emptyDocument } from "../../../../../engine/editor/api/Operations";
import {
  brushFaceKeys,
  brushFaceNormal,
  brushFaceST,
  fitBrushFace,
  setBrushFaceMaterial,
} from "../../../../../engine/editor/BrushFaces";
import { rotateBrush } from "../../../../../engine/editor/ConvexBrush";
import { faceTexMatrix, naturalFace } from "../../../../../engine/editor/FaceUv";
import { writeMap } from "../../../../../engine/editor/MapWriter";
import { CompileJobs } from "../../../../../engine/editor/server/CompileJobs";
import { resolveCompilerConfig } from "../../../../../engine/editor/server/CompilerConfig";
import { clearGameCompilerProfile } from "../../../../../engine/editor/server/GameCompilerProfile";
import { MapStore } from "../../../../../engine/editor/server/MapStore";
import { lockBrushBounds } from "../../../../../engine/editor/TextureLock";
import { BspLoader } from "../../../../../engine/loader/bsp/BspLoader";
import { resolveMapBspViaIndex } from "../../../../../engine/loader/pk3/NodePk3";
import { SweepCollisionBackend } from "../../../../../engine/physics/SweepCollisionBackend";
import { registerFpsCompilerProfile } from "../FpsCompilerProfile";

beforeEach(registerFpsCompilerProfile);
afterEach(clearGameCompilerProfile);

/** A shipped, drawn texture (256x256): new geometry is caulk unless textured. */
const VISIBLE = "cleansurface/pantonecoolgray10c";

it("compiles clipped slopes and convex subtraction with an open collision passage", async () => {
  const compiler = await resolveCompilerConfig();
  if (!compiler.available) return;
  const root = await mkdtemp(path.join(tmpdir(), "shagged-csg-"));
  try {
    const doc = applyOperations(emptyDocument("csgprobe"), [
      { op: "gen.room", id: "room", min: { x: -256, y: -256, z: 0 }, max: { x: 256, y: 256, z: 192 }, shader: VISIBLE },
      { op: "entity.place", classname: "info_player_deathmatch", origin: { x: 0, y: -160, z: 48 } },
      {
        op: "box.create",
        id: "wall",
        min: { x: -96, y: -8, z: 0 },
        max: { x: 96, y: 8, z: 128 },
        shader: VISIBLE,
        detail: true,
      },
      { op: "brush.rotate", id: "wall", axis: "z", degrees: 15 },
      { op: "box.create", id: "cutter", min: { x: -24, y: -64, z: -8 }, max: { x: 24, y: 64, z: 136 } },
      { op: "brush.subtract", ids: ["wall"], cutterId: "cutter", removeCutter: true },
      {
        op: "box.create",
        id: "slope",
        min: { x: 96, y: 96, z: 0 },
        max: { x: 160, y: 160, z: 128 },
        shader: VISIBLE,
        detail: true,
      },
      {
        op: "brush.clip",
        id: "slope",
        plane: { normal: { x: 1, y: 0, z: 1 }, distance: 224 },
        capMaterial: naturalFace(VISIBLE, [256, 256]),
      },
    ]).doc;
    const store = new MapStore(path.join(root, "maps"));
    await store.init();
    const saved = await store.save("csgprobe", writeMap(doc), 0, doc),
      data = path.join(root, "data");
    const jobs = new CompileJobs(store, compiler, path.join(root, "jobs"), undefined, data);
    const requested = await jobs.request("csgprobe", saved.revision, "fast"),
      completed = await jobs.wait(requested.id);
    expect(completed?.state, completed?.logs.join("\n")).toBe("playable");
    const bsp = BspLoader.load((await resolveMapBspViaIndex([data], "csgprobe"))!),
      collision = new SweepCollisionBackend();
    await collision.init(bsp);
    const across = (x: number) =>
      collision.trace(new Vector3(x, 64, -96), new Vector3(x, 64, 96), { radius: 0, height: 0 });
    expect(across(0).fraction).toBe(1);
    expect(across(80).fraction).toBeLessThan(1);
    const down = collision.trace(new Vector3(128, 160, 128), new Vector3(128, 16, 128), { radius: 0, height: 0 });
    expect(down.endPos.y).toBeCloseTo(96, 0);
    const cap = bsp.faces.find(
      (face) => Math.abs(face.normal[0] - Math.SQRT1_2) < 1e-3 && Math.abs(face.normal[2] - Math.SQRT1_2) < 1e-3,
    );
    expect(cap).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it("compiles rotated solids and prisms with correct collision and arbitrary-plane texture UVs", async () => {
  const compiler = await resolveCompilerConfig();
  if (!compiler.available) return;
  const root = await mkdtemp(path.join(tmpdir(), "shagged-convex-"));
  try {
    const footprint = Array.from({ length: 8 }, (_, i) => ({
      x: -160 + 32 * Math.cos((i * Math.PI) / 4),
      y: 32 * Math.sin((i * Math.PI) / 4),
    }));
    const doc = applyOperations(emptyDocument("convexprobe"), [
      { op: "gen.room", id: "room", min: { x: -256, y: -256, z: 0 }, max: { x: 256, y: 256, z: 192 }, shader: VISIBLE },
      { op: "entity.place", classname: "info_player_deathmatch", origin: { x: 0, y: -160, z: 48 } },
      {
        op: "box.create",
        id: "bridge",
        min: { x: -128, y: -16, z: 32 },
        max: { x: 128, y: 16, z: 48 },
        shader: VISIBLE,
        alignment: "natural",
        textureSizes: { [VISIBLE]: [256, 256] },
        detail: true,
      },
      { op: "brush.rotate", id: "bridge", axis: "z", degrees: 45 },
      { op: "gen.prism", id: "platform", footprint, bottom: 0, top: 64, shader: VISIBLE },
      {
        op: "box.create",
        id: "ramp",
        min: { x: 64, y: -160, z: 0 },
        max: { x: 128, y: -96, z: 64 },
        shader: VISIBLE,
        detail: true,
      },
      {
        op: "brush.vertices",
        id: "ramp",
        edits: [
          { index: 5, position: { x: 128, y: -160, z: 16 } },
          { index: 6, position: { x: 128, y: -96, z: 16 } },
        ],
      },
    ]).doc;
    const platformIndex = doc.brushes.findIndex((b) => b.id === "platform");
    const rotatedPlatform = rotateBrush(doc.brushes[platformIndex], "z", 17);
    const resizedPlatform = structuredClone(rotatedPlatform);
    resizedPlatform.min.x -= 11;
    resizedPlatform.max.x += 11;
    const platform = lockBrushBounds(rotatedPlatform, resizedPlatform);
    doc.brushes[platformIndex] = platform;
    expect(platform.hull!.sides[1].material!.skew).not.toBeUndefined();
    const ramp = doc.brushes.find((brush) => brush.id === "ramp")!;
    const rampTop = brushFaceKeys(ramp).find((key) => brushFaceNormal(ramp, key).z > 0.5)!;
    const rampMaterial = fitBrushFace(naturalFace(VISIBLE, [256, 256]), ramp, rampTop);
    setBrushFaceMaterial(ramp, rampTop, rampMaterial);
    const store = new MapStore(path.join(root, "maps"));
    await store.init();
    const saved = await store.save("convexprobe", writeMap(doc), 0, doc);
    const data = path.join(root, "data");
    const jobs = new CompileJobs(store, compiler, path.join(root, "jobs"), undefined, data);
    const requested = await jobs.request("convexprobe", saved.revision, "fast");
    const completed = await jobs.wait(requested.id);
    expect(completed?.state, completed?.logs.join("\n")).toBe("playable");
    const bsp = BspLoader.load((await resolveMapBspViaIndex([data], "convexprobe"))!);
    const collision = new SweepCollisionBackend();
    await collision.init(bsp);
    const down = (x: number, y: number) =>
      collision.trace(new Vector3(x, 120, y), new Vector3(x, 16, y), { radius: 0, height: 0 });
    expect(down(50, 50).fraction).toBeLessThan(1);
    expect(down(50, 50).endPos.y).toBeCloseTo(48, 0);
    expect(down(90, -90).fraction).toBe(1);
    expect(down(-160, 0).endPos.y).toBeCloseTo(64, 0);
    const platformFace = bsp.faces.find(
      (face) =>
        face.normal[2] > 0.99 &&
        bsp.vertices
          .slice(face.firstVertex, face.firstVertex + face.numVertices)
          .every((vertex) => Math.abs(vertex.position[2] - 64) < 1e-3 && vertex.position[0] < -90),
    )!;
    expect(platformFace).toBeDefined();
    let platformOffset: number[] | undefined;
    for (const vertex of bsp.vertices.slice(
      platformFace.firstVertex,
      platformFace.firstVertex + platformFace.numVertices,
    )) {
      const [x, y, z] = vertex.position,
        expected = brushFaceST(platform, 1, faceTexMatrix(platform.hull!.sides[1].material!), { x, y, z });
      platformOffset ??= [0, 1].map((axis) => Math.round(vertex.texCoord[axis] - expected[axis]));
      for (const axis of [0, 1]) expect(vertex.texCoord[axis] - expected[axis]).toBeCloseTo(platformOffset[axis], 4);
    }
    expect(down(96, -128).endPos.y).toBeCloseTo(40, 0);
    const sloped = bsp.faces.find((face) => face.normal[2] > 0.5 && face.normal[2] < 0.99)!;
    expect(sloped).toBeDefined();
    for (const vertex of bsp.vertices.slice(sloped.firstVertex, sloped.firstVertex + sloped.numVertices)) {
      const [x, y, z] = vertex.position;
      const expected = brushFaceST(ramp, rampTop, faceTexMatrix(rampMaterial), { x, y, z });
      expect(vertex.texCoord[0]).toBeCloseTo(expected[0], 4);
      expect(vertex.texCoord[1]).toBeCloseTo(expected[1], 4);
    }
    const diagonal = bsp.faces.find(
      (face) => Math.abs(Math.abs(face.normal[0]) - Math.SQRT1_2) < 1e-3 && Math.abs(face.normal[2]) < 1e-3,
    );
    expect(diagonal).toBeDefined();
    const normal = { x: diagonal!.normal[0], y: diagonal!.normal[1], z: diagonal!.normal[2] };
    const bridge = doc.brushes.find((b) => b.id === "bridge")!;
    const diagonalKey = brushFaceKeys(bridge).find((key) => {
      const n = brushFaceNormal(bridge, key);
      return Math.abs(n.x - normal.x) + Math.abs(n.y - normal.y) + Math.abs(n.z - normal.z) < 1e-3;
    })!;
    const vertices = bsp.vertices.slice(diagonal!.firstVertex, diagonal!.firstVertex + diagonal!.numVertices);
    let bridgeOffset: number[] | undefined;
    for (const vertex of vertices) {
      const [x, y, z] = vertex.position,
        expected = brushFaceST(
          bridge,
          diagonalKey,
          faceTexMatrix(bridge.hull!.sides[diagonalKey as number].material!),
          { x, y, z },
        );
      bridgeOffset ??= [0, 1].map((axis) => Math.round(vertex.texCoord[axis] - expected[axis]));
      for (const axis of [0, 1]) expect(vertex.texCoord[axis] - expected[axis]).toBeCloseTo(bridgeOffset[axis], 4);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
