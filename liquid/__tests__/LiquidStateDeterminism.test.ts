/**
 * Liquid state is deterministic across server, prediction and replay
 * (water Phase 1 exit gate).
 *
 * The server and the predicted client run the same `MovementProfile` over the
 * same commands. If their liquid samples can disagree, a swimmer rubber-bands;
 * if a reconciliation replay can produce a different sample than the original
 * step did, prediction diverges outright. Both are checked here against the
 * real collision stack rather than a stub, because the thing most likely to
 * differ is the trace, not the arithmetic.
 */

import { describe, expect, it } from "vitest";
import type { BspBrushSide, BspFile, BspPlane } from "../../../../engine/loader/bsp/BspLoader";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../../engine/network/components/TransformComponent";
import type { MovementInput } from "../../../../engine/network/systems/movement/MovementProfile";
import { ContentFlags, SurfaceFlags } from "../../../../engine/physics/ContentFlags";
import { SweepBackendAdapter } from "../../../../engine/physics/SweepBackendAdapter";
import { SweepCollisionBackend } from "../../../../engine/physics/SweepCollisionBackend";
import type { CollisionWorld } from "../../../../shared/collision/CollisionWorld";
import { SharedCollisionWorld } from "../../../../shared/collision/SharedCollisionWorld";
import { MovementProfile } from "../../simulation/MovementProfile";

type Triple = [number, number, number];

interface BoxSpec {
  min: Triple;
  max: Triple;
  name: string;
  contentFlags: number;
  surfaceFlags?: number;
}

function boxPlanes(min: Triple, max: Triple): BspPlane[] {
  return [
    { normal: [1, 0, 0], dist: max[0] },
    { normal: [-1, 0, 0], dist: -min[0] },
    { normal: [0, 1, 0], dist: max[1] },
    { normal: [0, -1, 0], dist: -min[1] },
    { normal: [0, 0, 1], dist: max[2] },
    { normal: [0, 0, -1], dist: -min[2] },
  ];
}

function buildBsp(boxes: BoxSpec[]): BspFile {
  const planes: BspPlane[] = [];
  const brushSides: BspBrushSide[] = [];
  const brushes: BspFile["brushes"] = [];
  const textures: BspFile["textures"] = [];
  const leafBrushes: number[] = [];

  boxes.forEach((box, i) => {
    textures.push({ name: box.name, contentFlags: box.contentFlags, surfaceFlags: box.surfaceFlags ?? 0 });
    const firstSide = brushSides.length;
    for (const p of boxPlanes(box.min, box.max)) {
      brushSides.push({ planeIndex: planes.length, shaderIndex: i });
      planes.push(p);
    }
    brushes.push({ firstSide, numSides: 6, shaderIndex: i });
    leafBrushes.push(i);
  });

  const big: Triple = [1e6, 1e6, 1e6];
  const negBig: Triple = [-1e6, -1e6, -1e6];

  return {
    header: { isFBSP: false },
    lumps: [],
    entities: [],
    textures,
    planes,
    nodes: [{ planeIndex: 0, children: [-1, -1] as [number, number], mins: negBig, maxs: big }],
    leafs: [
      {
        cluster: 0,
        area: 0,
        mins: negBig,
        maxs: big,
        firstLeafFace: 0,
        numLeafFaces: 0,
        firstLeafBrush: 0,
        numLeafBrushes: leafBrushes.length,
      },
    ],
    leafFaces: [],
    leafBrushes,
    models: [],
    brushes,
    brushSides,
    vertices: [],
    meshVerts: [],
    effects: [],
    faces: [],
    lightmaps: [],
    lightVols: [],
    visData: null,
    lightmapSize: 128,
  } as unknown as BspFile;
}

/** A floor at Q3 z=0 with a pool sunk into it, surface at z=64. */
async function makeWorld(): Promise<CollisionWorld> {
  const backend = new SweepCollisionBackend();
  await backend.init(
    buildBsp([
      { min: [-2000, -2000, -2000], max: [2000, 2000, 0], name: "floor", contentFlags: ContentFlags.SOLID },
      {
        min: [-256, -256, 0],
        max: [256, 256, 64],
        name: "textures/test/water1",
        contentFlags: ContentFlags.WATER | ContentFlags.TRANSLUCENT,
        surfaceFlags: SurfaceFlags.NONSOLID,
      },
    ]),
  );
  return new SharedCollisionWorld(new SweepBackendAdapter(backend));
}

function command(sequence: number, direction: Vec3, buttons = 0): MovementInput {
  return {
    direction,
    viewAngles: { pitch: 0, yaw: 0 },
    buttons,
    sequence,
    isPressed: (button: number) => (buttons & button) !== 0,
  };
}

/**
 * Walk north-east into the pool and keep going, so the stream crosses the
 * waterline rather than sitting on one side of it.
 */
function commandStream(): MovementInput[] {
  const stream: MovementInput[] = [];
  // 400 steps at 125 Hz is 3.2 s — long enough to run the ~650 units from the
  // start position, through the pool, and out the far side.
  for (let i = 1; i <= 400; i++) {
    // Straight run, with a jump partway so the stream is not purely a ground
    // path and the airborne branch gets sampled too.
    stream.push(command(i, { x: 0, y: 0, z: 1 }, i === 150 ? InputButtons.JUMP : 0));
  }
  return stream;
}

/** Run a stream from a fixed start and record the water level after each step. */
function run(collision: CollisionWorld, stream: MovementInput[]): number[] {
  const profile = new MovementProfile();
  const levels: number[] = [];
  let position: Vec3 = { x: 0, y: 100, z: -400 };
  let velocity: Vec3 = { x: 0, y: 0, z: 0 };

  for (const input of stream) {
    const result = profile.simulate(position, velocity, input, 1 / 125, collision);
    position = result.position;
    velocity = result.velocity;
    levels.push(result.waterLevel ?? 0);
  }

  return levels;
}

describe("liquid state determinism", () => {
  it("server and predicted client agree for the same command stream", async () => {
    const collision = await makeWorld();
    const stream = commandStream();

    // Two independent profiles, exactly as the server and the predicting
    // client each hold their own.
    const server = run(collision, stream);
    const client = run(collision, stream);

    expect(client).toEqual(server);
  });

  it("a replay of the same commands reproduces the same levels", async () => {
    // Reconciliation re-simulates old commands from a corrected state. The
    // sample must be recomputed from position and geometry, never carried
    // forward, or the replay inherits a level the world no longer supports.
    const collision = await makeWorld();
    const stream = commandStream();

    const original = run(collision, stream);
    const replay = run(collision, stream);

    expect(replay).toEqual(original);
  });

  it("actually crosses the waterline, so the agreement means something", async () => {
    // A test that only ever compares two dry runs would pass forever.
    const collision = await makeWorld();

    const levels = run(collision, commandStream());

    expect(new Set(levels).size).toBeGreaterThan(1);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(1);
  });

  it("reports dry with no collision world at all", async () => {
    const profile = new MovementProfile();

    const result = profile.simulate(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      command(1, { x: 0, y: 0, z: 0 }),
      1 / 125,
      null,
    );

    expect(result.waterLevel).toBe(0);
    expect(result.liquidKind).toBeNull();
  });

  it("reports the level from the position the step ended at", async () => {
    // Sampling the entry position instead would report last step's answer,
    // which is a frame of lag exactly at the surface where it is most visible.
    const collision = await makeWorld();
    const profile = new MovementProfile();

    // Start above the pool and fall in over a few steps.
    let position: Vec3 = { x: 0, y: 200, z: 0 };
    let velocity: Vec3 = { x: 0, y: 0, z: 0 };
    let sawWater = false;

    for (let i = 1; i <= 200 && !sawWater; i++) {
      const result = profile.simulate(position, velocity, command(i, { x: 0, y: 0, z: 0 }), 1 / 125, collision);
      position = result.position;
      velocity = result.velocity;
      if ((result.waterLevel ?? 0) > 0) {
        sawWater = true;
        // The reported level must match a fresh sample at the reported position.
        const feetY = position.y - 24;
        expect(collision.pointContents({ x: position.x, y: feetY + 1, z: position.z })).not.toBe(0);
      }
    }

    expect(sawWater).toBe(true);
  });
});
