/**
 * The swim hull and the swim animation stay paired (water Phase 3).
 *
 * The moving clip lays the body flat, so the hull lies flat with it; the
 * treading clip stands upright, so the hull does too. The rule that matters is
 * that they can never disagree — a player rendered prone with a standing hull
 * is a hitbox lie, and a player who stands up inside a ceiling is stuck.
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

const WATER: Omit<BoxSpec, "min" | "max"> = {
  name: "textures/test/water1",
  contentFlags: ContentFlags.WATER | ContentFlags.TRANSLUCENT,
  surfaceFlags: SurfaceFlags.NONSOLID,
};

async function world(boxes: BoxSpec[]): Promise<CollisionWorld> {
  const backend = new SweepCollisionBackend();
  await backend.init(buildBsp(boxes));
  return new SharedCollisionWorld(new SweepBackendAdapter(backend));
}

/** An open pool: water from z=0 to z=512, nothing overhead. */
const openPool = () =>
  world([
    { min: [-4000, -4000, -4000], max: [4000, 4000, 0], name: "floor", contentFlags: ContentFlags.SOLID },
    { min: [-512, -512, 0], max: [512, 512, 512], ...WATER },
  ]);

/**
 * A flooded tunnel: water everywhere, with a solid ceiling 20 units above the
 * player origin. The standing hull reaches 32 above the origin, so it does not
 * fit; the prone hull reaches 14, so it does.
 */
const floodedTunnel = () =>
  world([
    { min: [-4000, -4000, -4000], max: [4000, 4000, 0], name: "floor", contentFlags: ContentFlags.SOLID },
    { min: [-512, -512, 0], max: [512, 512, 512], ...WATER },
    { min: [-512, -512, 220], max: [512, 512, 300], name: "ceiling", contentFlags: ContentFlags.SOLID },
  ]);

function command(sequence: number, buttons = 0, dir: Vec3 = { x: 0, y: 0, z: 0 }): MovementInput {
  return {
    direction: dir,
    viewAngles: { pitch: 0, yaw: 0 },
    buttons,
    sequence,
    isPressed: (b: number) => (buttons & b) !== 0,
  };
}

/** Run a profile and report whether the resulting hull is the prone one. */
function isProne(profile: MovementProfile): boolean {
  // The prone hull is the only one that reaches just 14 above the origin.
  const bounds = (profile as unknown as { getCurrentBounds(): { max: { y: number } } }).getCurrentBounds();
  return bounds.max.y === 14;
}

function swim(
  profile: MovementProfile,
  collision: CollisionWorld,
  start: Vec3,
  steps: number,
  make: (i: number) => MovementInput,
): Vec3 {
  let position = start;
  let velocity: Vec3 = { x: 0, y: 0, z: 0 };
  for (let i = 1; i <= steps; i++) {
    const result = profile.simulate(position, velocity, make(i), 1 / 125, collision);
    position = result.position;
    velocity = result.velocity;
  }
  return position;
}

describe("the swim hull follows the swim animation", () => {
  it("lies flat while moving", async () => {
    const collision = await openPool();
    const profile = new MovementProfile();

    swim(profile, collision, { x: 0, y: 200, z: 0 }, 20, (i) => command(i, InputButtons.FORWARD, { x: 0, y: 0, z: 1 }));

    expect(isProne(profile)).toBe(true);
  });

  it("stands back up while treading", async () => {
    const collision = await openPool();
    const profile = new MovementProfile();

    // Move first so the hull goes prone, then stop.
    swim(profile, collision, { x: 0, y: 200, z: 0 }, 20, (i) => command(i, InputButtons.FORWARD, { x: 0, y: 0, z: 1 }));
    expect(isProne(profile)).toBe(true);

    swim(profile, collision, { x: 0, y: 200, z: 0 }, 20, (i) => command(i));

    expect(isProne(profile)).toBe(false);
  });

  it("counts ascending and descending as moving", async () => {
    // Holding Space is swimming even with no directional input, so the body
    // should be flat rather than treading in place.
    const collision = await openPool();
    const profile = new MovementProfile();

    swim(profile, collision, { x: 0, y: 200, z: 0 }, 20, (i) => command(i, InputButtons.JUMP));

    expect(isProne(profile)).toBe(true);
  });

  it("stays flat when there is no room to stand up", async () => {
    // The hull only ever shrinks freely. Growing it inside a ceiling is how a
    // player ends up embedded in geometry, so a swimmer under a low overhang
    // stays prone — and therefore stays in the moving clip, so the hitbox and
    // the model still agree.
    const collision = await floodedTunnel();
    const profile = new MovementProfile();

    // Sit just under the ceiling: origin 200, standing hull reaches 232, the
    // ceiling starts at 220. Prone reaches 214 and fits.
    swim(profile, collision, { x: 0, y: 200, z: 0 }, 20, (i) => command(i, InputButtons.FORWARD, { x: 0, y: 0, z: 1 }));
    expect(isProne(profile)).toBe(true);

    swim(profile, collision, { x: 0, y: 200, z: 0 }, 40, (i) => command(i));

    expect(isProne(profile)).toBe(true);
  });

  it("is never prone on dry land", async () => {
    const dry = await world([
      { min: [-4000, -4000, -4000], max: [4000, 4000, 0], name: "floor", contentFlags: ContentFlags.SOLID },
    ]);
    const profile = new MovementProfile();

    swim(profile, dry, { x: 0, y: 24, z: 0 }, 40, (i) => command(i, InputButtons.FORWARD, { x: 0, y: 0, z: 1 }));

    expect(isProne(profile)).toBe(false);
  });

  it("stands back up on leaving the water entirely", async () => {
    const collision = await openPool();
    const profile = new MovementProfile();

    swim(profile, collision, { x: 0, y: 200, z: 0 }, 20, (i) => command(i, InputButtons.FORWARD, { x: 0, y: 0, z: 1 }));
    expect(isProne(profile)).toBe(true);

    // Well outside the pool, on dry ground.
    swim(profile, collision, { x: 2000, y: 24, z: 2000 }, 10, (i) => command(i));

    expect(isProne(profile)).toBe(false);
  });
});
