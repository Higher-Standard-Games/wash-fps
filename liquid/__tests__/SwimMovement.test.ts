/**
 * Swimming end to end (water Phase 2 exit gate).
 *
 * A headless player has to be able to enter a liquid, sink, ascend, descend,
 * swim along their view pitch, leave, and reconcile without divergence. These
 * run the real `MovementProfile` against the real collision stack, because the
 * interesting failures live in the branch selection and the traces, not in the
 * arithmetic that `Swim.test.ts` already covers.
 *
 * WORLD (Q3 coords, z up; the profile's API is Babylon, y up):
 *   floor  z <= 0
 *   pool   x,y in [-256, 256], z in [0, 512]  — deep enough to swim in
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

async function deepPool(): Promise<CollisionWorld> {
  const backend = new SweepCollisionBackend();
  await backend.init(
    buildBsp([
      { min: [-4000, -4000, -4000], max: [4000, 4000, 0], name: "floor", contentFlags: ContentFlags.SOLID },
      {
        min: [-256, -256, 0],
        max: [256, 256, 512],
        name: "textures/test/water1",
        contentFlags: ContentFlags.WATER | ContentFlags.TRANSLUCENT,
        surfaceFlags: SurfaceFlags.NONSOLID,
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
  waterLevel: number;
}

/** Step a profile n times with the same command, reporting the final state. */
function hold(
  profile: MovementProfile,
  collision: CollisionWorld,
  start: RunState,
  steps: number,
  make: (i: number) => MovementInput,
): RunState {
  let { position, velocity } = start;
  let waterLevel = start.waterLevel;

  for (let i = 1; i <= steps; i++) {
    const result = profile.simulate(position, velocity, make(i), 1 / 125, collision);
    position = result.position;
    velocity = result.velocity;
    waterLevel = result.waterLevel ?? 0;
  }

  return { position, velocity, waterLevel };
}

/** Mid-pool, well below the surface at Babylon y=512. */
const SUBMERGED: RunState = {
  position: { x: 0, y: 300, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  waterLevel: 3,
};

describe("swimming", () => {
  it("sinks when the player asks for nothing", async () => {
    const collision = await deepPool();

    const end = hold(new MovementProfile(), collision, SUBMERGED, 125, (i) => command(i));

    expect(end.position.y).toBeLessThan(SUBMERGED.position.y);
    // Sinking, not falling: gravity would be far faster over a second.
    expect(end.velocity.y).toBeGreaterThan(-120);
    expect(end.velocity.y).toBeLessThan(0);
  });

  it("does not accelerate downward the way a fall does", async () => {
    const collision = await deepPool();
    const profile = new MovementProfile();

    const half = hold(profile, collision, SUBMERGED, 62, (i) => command(i));
    const full = hold(profile, collision, half, 62, (i) => command(i + 62));

    // Terminal sink speed, so the second half-second drops roughly as far as
    // the first. A falling body would drop several times further.
    const firstDrop = SUBMERGED.position.y - half.position.y;
    const secondDrop = half.position.y - full.position.y;
    expect(secondDrop).toBeLessThan(firstDrop * 2);
  });

  it("ascends on jump", async () => {
    const collision = await deepPool();

    const end = hold(new MovementProfile(), collision, SUBMERGED, 125, (i) =>
      command(i, { buttons: InputButtons.JUMP }),
    );

    expect(end.position.y).toBeGreaterThan(SUBMERGED.position.y);
  });

  it("descends on crouch", async () => {
    const collision = await deepPool();

    const end = hold(new MovementProfile(), collision, SUBMERGED, 125, (i) =>
      command(i, { buttons: InputButtons.CROUCH }),
    );

    expect(end.position.y).toBeLessThan(SUBMERGED.position.y);
  });

  it("swims upward when looking up and holding forward", async () => {
    // The control that makes a Quake swimmer feel right: no button needed.
    const collision = await deepPool();

    const end = hold(new MovementProfile(), collision, SUBMERGED, 125, (i) =>
      command(i, { dir: { x: 0, y: 0, z: 1 }, pitch: -Math.PI / 3, buttons: InputButtons.FORWARD }),
    );

    expect(end.position.y).toBeGreaterThan(SUBMERGED.position.y);
  });

  it("swims downward when looking down and holding forward", async () => {
    const collision = await deepPool();

    const end = hold(new MovementProfile(), collision, SUBMERGED, 125, (i) =>
      command(i, { dir: { x: 0, y: 0, z: 1 }, pitch: Math.PI / 3, buttons: InputButtons.FORWARD }),
    );

    expect(end.position.y).toBeLessThan(SUBMERGED.position.y);
  });

  it("caps horizontal swim speed well below running speed", async () => {
    const collision = await deepPool();

    const end = hold(new MovementProfile(), collision, SUBMERGED, 250, (i) =>
      command(i, { dir: { x: 0, y: 0, z: 1 }, buttons: InputButtons.FORWARD }),
    );

    const horizontal = Math.hypot(end.velocity.x, end.velocity.z);
    // Base speed is 280 and the swim cap is half of it. Friction keeps the
    // steady state under the cap rather than at it.
    expect(horizontal).toBeLessThanOrEqual(141);
    expect(horizontal).toBeGreaterThan(0);
  });
});

describe("wading", () => {
  /**
   * Shallow enough to wade rather than swim.
   *
   * Surface at Babylon y=20 with the floor at 0. A player standing here has
   * their origin at 24, feet at 0 and waist at 29 — so the water covers the
   * foot probe and nothing else. Forty units would already be waist-deep and
   * therefore swimming: the ladder is about the body, not about ankle height.
   */
  async function shallowPool(): Promise<CollisionWorld> {
    const backend = new SweepCollisionBackend();
    await backend.init(
      buildBsp([
        { min: [-4000, -4000, -4000], max: [4000, 4000, 0], name: "floor", contentFlags: ContentFlags.SOLID },
        {
          min: [-1000, -1000, 0],
          max: [1000, 1000, 20],
          name: "textures/test/water1",
          contentFlags: ContentFlags.WATER,
          surfaceFlags: SurfaceFlags.NONSOLID,
        },
      ]),
    );
    return new SharedCollisionWorld(new SweepBackendAdapter(backend));
  }

  it("moves slower through shallow water than over dry ground", async () => {
    const wet = await shallowPool();
    const dryBackend = new SweepCollisionBackend();
    await dryBackend.init(
      buildBsp([{ min: [-4000, -4000, -4000], max: [4000, 4000, 0], name: "floor", contentFlags: ContentFlags.SOLID }]),
    );
    const dry = new SharedCollisionWorld(new SweepBackendAdapter(dryBackend));

    const start: RunState = { position: { x: 0, y: 24, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, waterLevel: 0 };
    const run = (world: CollisionWorld) =>
      hold(new MovementProfile(), world, start, 125, (i) =>
        command(i, { dir: { x: 0, y: 0, z: 1 }, buttons: InputButtons.FORWARD }),
      );

    const wetEnd = run(wet);
    const dryEnd = run(dry);

    expect(wetEnd.position.z).toBeLessThan(dryEnd.position.z);
  });

  it("still walks rather than swims", async () => {
    const wet = await shallowPool();

    const end = hold(
      new MovementProfile(),
      wet,
      { position: { x: 0, y: 24, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, waterLevel: 0 },
      125,
      (i) => command(i, { dir: { x: 0, y: 0, z: 1 }, buttons: InputButtons.FORWARD }),
    );

    // Feet wet, waist dry: wading, and still standing on the floor rather than
    // sinking. The exact resting height is a collision-epsilon detail; what
    // matters is that the player did not settle downward the way a swimmer
    // with no ascend input does.
    expect(end.waterLevel).toBe(1);
    expect(end.position.y).toBeGreaterThan(20);
    expect(end.position.y).toBeLessThan(32);
  });
});

describe("leaving the water", () => {
  it("reaches the surface and stops rising", async () => {
    const collision = await deepPool();

    const end = hold(new MovementProfile(), collision, SUBMERGED, 400, (i) =>
      command(i, { buttons: InputButtons.JUMP }),
    );

    // Swum up to the surface and settled around it rather than flying out.
    expect(end.position.y).toBeGreaterThan(400);
    expect(end.waterLevel).toBeLessThan(3);
  });

  it("does not leave a stale sliding or ledge state behind", async () => {
    const collision = await deepPool();
    const profile = new MovementProfile();

    const end = hold(profile, collision, SUBMERGED, 60, (i) =>
      command(i, { dir: { x: 0, y: 0, z: 1 }, buttons: InputButtons.CROUCH | InputButtons.FORWARD }),
    );

    // Crouch is descend input while swimming. If the slide system saw it, a
    // player who never touched a floor would come out of the pool sliding.
    const result = profile.simulate(end.position, end.velocity, command(999), 1 / 125, collision);
    expect(result.isSliding).toBe(false);
    expect(result.ledgeGrabState).toBe("none");
  });
});

describe("determinism across the swim branch", () => {
  const stream = (i: number) =>
    command(i, {
      dir: { x: 0, y: 0, z: 1 },
      pitch: Math.sin(i / 30) * 0.6,
      buttons: i % 40 < 20 ? InputButtons.FORWARD | InputButtons.JUMP : InputButtons.FORWARD,
    });

  it("two independent profiles agree over a swimming command stream", async () => {
    // Server and predicted client, each holding their own profile.
    const collision = await deepPool();

    const server = hold(new MovementProfile(), collision, SUBMERGED, 300, stream);
    const client = hold(new MovementProfile(), collision, SUBMERGED, 300, stream);

    expect(client.position).toEqual(server.position);
    expect(client.velocity).toEqual(server.velocity);
    expect(client.waterLevel).toBe(server.waterLevel);
  });

  it("a replay of the same commands lands in the same place", async () => {
    const collision = await deepPool();

    const original = hold(new MovementProfile(), collision, SUBMERGED, 300, stream);
    const replay = hold(new MovementProfile(), collision, SUBMERGED, 300, stream);

    expect(replay.position).toEqual(original.position);
  });

  it("crosses the waterline during that stream, so agreement means something", async () => {
    const collision = await deepPool();
    const profile = new MovementProfile();
    const seen = new Set<number>();

    let state = SUBMERGED;
    for (let i = 1; i <= 600; i++) {
      state = hold(profile, collision, state, 1, () => stream(i));
      seen.add(state.waterLevel);
    }

    expect(seen.size).toBeGreaterThan(1);
  });
});
