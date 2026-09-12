/**
 * Ladder climbing end to end.
 *
 * Runs the real `MovementProfile` against the real collision stack, because
 * the interesting failures live in the hull test and the branch selection, not
 * in the arithmetic `Ladder.ts` does.
 *
 * The world reproduces the shape shipped maps actually use: a ladder brush
 * bolted flat to a wall, reaching 16 units into the room. That geometry is the
 * whole reason climbing needs a hull test — a player pressed against the wall
 * has their ORIGIN tangent to the brush's outer face, never inside it.
 *
 * WORLD (Q3 coords, z up; the profile's API is Babylon, y up):
 *   floor   z <= 0
 *   wall    y in [64, 128]
 *   ladder  y in [48, 64], z in [0, 416]   — nonsolid, SURF_LADDER
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
import { MovementProfile } from "../MovementProfile";

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

/** The flags a shipped ladder actually carries (`textures/common/ladder`). */
const LADDER_SURFACE = SurfaceFlags.LADDER | SurfaceFlags.NONSOLID | SurfaceFlags.NODRAW;
const LADDER_CONTENTS = ContentFlags.PLAYERCLIP | ContentFlags.TRANSLUCENT;

async function ladderRoom(): Promise<CollisionWorld> {
  const backend = new SweepCollisionBackend();
  await backend.init(
    buildBsp([
      { min: [-4000, -4000, -4000], max: [4000, 4000, 0], name: "floor", contentFlags: ContentFlags.SOLID },
      { min: [-4000, 64, 0], max: [4000, 128, 4000], name: "wall", contentFlags: ContentFlags.SOLID },
      {
        min: [-40, 48, 0],
        max: [40, 64, 416],
        name: "textures/common/ladder",
        contentFlags: LADDER_CONTENTS,
        surfaceFlags: LADDER_SURFACE,
      },
    ]),
  );
  return new SharedCollisionWorld(new SweepBackendAdapter(backend));
}

function command(
  sequence: number,
  opts: { dir?: Vec3; pitch?: number; yaw?: number; buttons?: number } = {},
): MovementInput {
  const buttons = opts.buttons ?? 0;
  return {
    direction: opts.dir ?? { x: 0, y: 0, z: 0 },
    viewAngles: { pitch: opts.pitch ?? 0, yaw: opts.yaw ?? 0 },
    buttons,
    sequence,
    isPressed: (b: number) => (buttons & b) !== 0,
  };
}

interface RunState {
  position: Vec3;
  velocity: Vec3;
  onLadder: boolean;
}

function hold(
  profile: MovementProfile,
  collision: CollisionWorld,
  start: RunState,
  steps: number,
  make: (i: number) => MovementInput,
): RunState {
  let { position, velocity } = start;
  let onLadder = start.onLadder;

  for (let i = 1; i <= steps; i++) {
    const result = profile.simulate(position, velocity, make(i), 1 / 125, collision);
    position = result.position;
    velocity = result.velocity;
    onLadder = result.onLadder ?? false;
  }

  return { position, velocity, onLadder };
}

/**
 * Standing on the floor pressed against the ladder wall.
 *
 * Babylon (x, y, z) = Q3 (x, z, y). The wall face is at Q3 y=64 and the hull
 * radius is 16, so Q3 y=48 is as close as a body can get — exactly the outer
 * face of the ladder brush.
 */
const AT_FOOT: RunState = {
  position: { x: 0, y: 24, z: 48 },
  velocity: { x: 0, y: 0, z: 0 },
  onLadder: false,
};

/** Yaw facing +z in Babylon, i.e. into the wall. */
const INTO_WALL = 0;
/** Straight forward, in the profile's world-relative wish form. */
const FORWARD: Vec3 = { x: 0, y: 0, z: 1 };
/** Looking up. The profile's forward vector uses -sin(pitch) for y. */
const LOOK_UP = -Math.PI / 4;
const LOOK_DOWN = Math.PI / 4;

describe("ladder detection", () => {
  it("finds the ladder from where a body can actually stand, which the origin alone cannot", async () => {
    const backend = new SweepCollisionBackend();
    await backend.init(
      buildBsp([
        { min: [-4000, -4000, -4000], max: [4000, 4000, 0], name: "floor", contentFlags: ContentFlags.SOLID },
        { min: [-4000, 64, 0], max: [4000, 128, 4000], name: "wall", contentFlags: ContentFlags.SOLID },
        {
          min: [-40, 48, 0],
          max: [40, 64, 416],
          name: "textures/common/ladder",
          contentFlags: LADDER_CONTENTS,
          surfaceFlags: LADDER_SURFACE,
        },
      ]),
    );

    // The hull straddles the brush: origin tangent to it, body overlapping it.
    const hullMin = { x: -16, y: 0, z: 32 };
    const hullMax = { x: 16, y: 64, z: 64 };
    expect(backend.isInLadder(hullMin as never, hullMax as never)).toBe(true);

    // Across the room there is nothing to climb.
    expect(backend.isInLadder({ x: -16, y: 0, z: -300 } as never, { x: 16, y: 64, z: -268 } as never)).toBe(false);
  });
});

describe("climbing", () => {
  it("climbs when the player looks up and holds forward", async () => {
    const collision = await ladderRoom();

    const end = hold(new MovementProfile(), collision, AT_FOOT, 125, (i) =>
      command(i, { dir: FORWARD, pitch: LOOK_UP, yaw: INTO_WALL }),
    );

    expect(end.onLadder).toBe(true);
    expect(end.position.y).toBeGreaterThan(AT_FOOT.position.y + 64);
  });

  it("does not bog down someone walking past the foot of a ladder", async () => {
    const collision = await ladderRoom();

    // Inside the volume, but asking to run sideways rather than to climb.
    const end = hold(new MovementProfile(), collision, AT_FOOT, 60, (i) =>
      command(i, { dir: { x: 1, y: 0, z: 0 }, pitch: 0, yaw: INTO_WALL }),
    );

    expect(end.onLadder).toBe(false);
    // Ground movement, not the climb branch: they travelled, and did not rise.
    expect(Math.abs(end.position.x)).toBeGreaterThan(32);
    expect(end.position.y).toBeLessThan(AT_FOOT.position.y + 8);
  });

  it("holds position on the rungs when the keys are released", async () => {
    const collision = await ladderRoom();
    const profile = new MovementProfile();

    const up = hold(profile, collision, AT_FOOT, 125, (i) =>
      command(i, { dir: FORWARD, pitch: LOOK_UP, yaw: INTO_WALL }),
    );
    const parked = hold(profile, collision, up, 125, (i) => command(125 + i, { yaw: INTO_WALL }));

    expect(parked.onLadder).toBe(true);
    // Friction parks the climber rather than letting them coast or fall.
    expect(Math.abs(parked.position.y - up.position.y)).toBeLessThan(16);
  });

  it("descends when the player looks down and holds forward", async () => {
    const collision = await ladderRoom();
    const profile = new MovementProfile();

    const up = hold(profile, collision, AT_FOOT, 150, (i) =>
      command(i, { dir: FORWARD, pitch: LOOK_UP, yaw: INTO_WALL }),
    );
    const down = hold(profile, collision, up, 100, (i) =>
      command(150 + i, { dir: FORWARD, pitch: LOOK_DOWN, yaw: INTO_WALL }),
    );

    expect(down.position.y).toBeLessThan(up.position.y);
  });

  it("lets go on jump and does not reattach while still inside the volume", async () => {
    const collision = await ladderRoom();
    const profile = new MovementProfile();

    const up = hold(profile, collision, AT_FOOT, 150, (i) =>
      command(i, { dir: FORWARD, pitch: LOOK_UP, yaw: INTO_WALL }),
    );
    expect(up.onLadder).toBe(true);

    // One jump, then nothing: the player must come off and stay off, even
    // though the hull has not left the brush yet.
    const after = hold(profile, collision, up, 30, (i) =>
      command(150 + i, { buttons: i === 1 ? InputButtons.JUMP : 0, yaw: INTO_WALL }),
    );

    expect(after.onLadder).toBe(false);
  });

  it("falls rather than climbing when there is no ladder", async () => {
    const backend = new SweepCollisionBackend();
    await backend.init(
      buildBsp([{ min: [-4000, -4000, -4000], max: [4000, 4000, 0], name: "floor", contentFlags: ContentFlags.SOLID }]),
    );
    const collision = new SharedCollisionWorld(new SweepBackendAdapter(backend));

    const start: RunState = { position: { x: 0, y: 300, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onLadder: false };
    const end = hold(new MovementProfile(), collision, start, 60, (i) =>
      command(i, { dir: FORWARD, pitch: LOOK_UP, yaw: INTO_WALL }),
    );

    expect(end.onLadder).toBe(false);
    expect(end.position.y).toBeLessThan(start.position.y);
  });
});
