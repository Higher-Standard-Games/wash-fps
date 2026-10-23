import { describe, expect, it, vi } from "vitest";
import type { BspFile } from "../../../../engine/loader/bsp/BspLoader";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import { SweepBackendAdapter } from "../../../../engine/physics/SweepBackendAdapter";
import { SweepCollisionBackend } from "../../../../engine/physics/SweepCollisionBackend";
import type { AABB, SweepBackend } from "../../../../shared/collision/CollisionWorld";
import { SharedCollisionWorld } from "../../../../shared/collision/SharedCollisionWorld";
import { MovementProfile } from "../MovementProfile";

const bounds: AABB = { min: { x: -16, y: -24, z: -16 }, max: { x: 16, y: 40, z: 16 } };

function support(normal: { x: number; y: number; z: number }, fraction = 0.01, hitCount = 0) {
  const backend: SweepBackend = {
    trace: vi.fn(() => ({ fraction, normal })),
    stepSlideMove: (_start, movement) => ({ endPos: { x: 1, y: 25, z: 0 }, velocity: movement, hitCount }),
    pointContents: () => 0,
  };
  return new SharedCollisionWorld(backend);
}

describe("SharedCollisionWorld uphill support", () => {
  it("retains support for tangent uphill motion without an impact this frame", () => {
    const world = support({ x: -0.6, y: 0.8, z: 0 });
    expect(world.stepSlideMove({ x: 0, y: 24, z: 0 }, { x: 300, y: 225, z: 0 }, 0.008, bounds).grounded).toBe(true);
  });

  it.each([0, 1])("does not ground a jump leaving a ramp, even with an unrelated hit (%i)", (hits) => {
    const world = support({ x: -0.6, y: 0.8, z: 0 }, 0.01, hits);
    expect(world.stepSlideMove({ x: 0, y: 24, z: 0 }, { x: 300, y: 545, z: 0 }, 0.008, bounds).grounded).toBe(false);
  });

  it("does not ground a small upward slide bump above a flat floor", () => {
    const world = support({ x: 0, y: 1, z: 0 });
    expect(world.stepSlideMove({ x: 0, y: 24, z: 0 }, { x: 300, y: 70, z: 0 }, 0.008, bounds).grounded).toBe(false);
  });

  it("requires nearby walkable support", () => {
    for (const world of [support({ x: -0.8, y: 0.6, z: 0 }), support({ x: -0.6, y: 0.8, z: 0 }, 1)]) {
      expect(world.stepSlideMove({ x: 0, y: 24, z: 0 }, { x: 300, y: 225, z: 0 }, 0.008, bounds).grounded).toBe(false);
    }
  });
});

/** A solid ramp prism: Q3 z <= x/4, bounded far beyond the tested route. */
async function rampWorld() {
  const scale = Math.hypot(0.25, 1);
  const planes = [
    { normal: [1, 0, 0], dist: 1000 },
    { normal: [-1, 0, 0], dist: 1000 },
    { normal: [0, 1, 0], dist: 1000 },
    { normal: [0, -1, 0], dist: 1000 },
    { normal: [-0.25 / scale, 0, 1 / scale], dist: 0 },
    { normal: [0, 0, -1], dist: 1000 },
  ];
  const bsp = {
    header: { isFBSP: false },
    entities: [],
    textures: [{ name: "ramp", contentFlags: 1, surfaceFlags: 0 }],
    planes,
    brushSides: planes.map((_, planeIndex) => ({ planeIndex, shaderIndex: 0 })),
    brushes: [{ firstSide: 0, numSides: 6, shaderIndex: 0 }],
    nodes: [{ planeIndex: 0, children: [-1, -1] }],
    leafs: [{ firstLeafBrush: 0, numLeafBrushes: 1, firstLeafFace: 0, numLeafFaces: 0 }],
    leafBrushes: [0],
    leafFaces: [],
    models: [],
    vertices: [],
    faces: [],
    meshVerts: [],
  } as unknown as BspFile;
  const backend = new SweepCollisionBackend();
  await backend.init(bsp);
  return { backend, world: new SharedCollisionWorld(new SweepBackendAdapter(backend)) };
}

it("walks a real brush ramp for 125 ticks without repeated ground loss, then jumps off", async () => {
  const { backend, world } = await rampWorld();
  try {
    const profile = new MovementProfile();
    profile.resetPhysicsState(true);
    let position = { x: 0, y: 28.04, z: 0 },
      velocity = { x: 280, y: 0, z: 0 };
    for (let tick = 0; tick <= 125; tick++) {
      const buttons = InputButtons.FORWARD | (tick === 125 ? InputButtons.JUMP : 0);
      const input = {
        direction: { x: 1, y: 0, z: 0 },
        viewAngles: { pitch: 0, yaw: 0 },
        buttons,
        sequence: tick,
        simStep: tick,
        isPressed: (b: number) => (buttons & b) !== 0,
      };
      const result = profile.simulate(position, velocity, input, 0.008, world);
      expect(result.grounded, `tick ${tick}`).toBe(tick < 125);
      if (tick === 125) expect(result.velocity.y).toBeGreaterThan(200);
      position = result.position;
      velocity = result.velocity;
    }
    expect(position.x).toBeGreaterThan(200);
  } finally {
    backend.dispose();
  }
});
