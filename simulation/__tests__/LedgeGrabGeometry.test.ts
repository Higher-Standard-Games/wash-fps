import { describe, expect, it, vi } from "vitest";
import type { BspFile } from "../../../../engine/loader/bsp/BspLoader";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import { SweepBackendAdapter } from "../../../../engine/physics/SweepBackendAdapter";
import { SweepCollisionBackend } from "../../../../engine/physics/SweepCollisionBackend";
import { SharedCollisionWorld } from "../../../../shared/collision/SharedCollisionWorld";
import { LedgeGrab } from "../LedgeGrab";
import { DEFAULT_FPS_MOVEMENT_CONFIG } from "../MovementProfile";

const hull = { min: { x: -16, y: -24, z: -16 }, max: { x: 16, y: 40, z: 16 } };

async function ledge(angle: number, curved = false, tilt = 0) {
  const direction = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
  const normal = { x: -direction.x, y: 0, z: -direction.z };
  const planes = curved
    ? Array.from({ length: 32 }, (_, i) => {
        const a = angle + (i * Math.PI) / 16;
        return { normal: [Math.sin(a), Math.cos(a), 0], dist: 128 };
      })
    : [
        {
          normal: [-direction.x / Math.hypot(1, tilt), -direction.z / Math.hypot(1, tilt), tilt / Math.hypot(1, tilt)],
          dist: 0,
        },
        { normal: [direction.x, direction.z, 0], dist: 256 },
        { normal: [direction.z, -direction.x, 0], dist: 256 },
        { normal: [-direction.z, direction.x, 0], dist: 256 },
      ];
  planes.push({ normal: [0, 0, 1], dist: 100 }, { normal: [0, 0, -1], dist: 100 });
  const bsp = {
    header: { isFBSP: false },
    entities: [],
    models: [],
    textures: [{ name: "solid", contentFlags: 1, surfaceFlags: 0 }],
    planes,
    brushes: [{ firstSide: 0, numSides: planes.length, shaderIndex: 0 }],
    brushSides: planes.map((_, planeIndex) => ({ planeIndex, shaderIndex: 0 })),
    nodes: [{ planeIndex: 0, children: [-1, -1] }],
    leafs: [{ firstLeafBrush: 0, numLeafBrushes: 1, firstLeafFace: 0, numLeafFaces: 0 }],
    leafBrushes: [0],
    leafFaces: [],
    faces: [],
    vertices: [],
    meshVerts: [],
  } as unknown as BspFile;
  const backend = new SweepCollisionBackend();
  await backend.init(bsp);
  const world = new SharedCollisionWorld(new SweepBackendAdapter(backend));
  // The AABB's support distance changes with wall orientation.
  const offset = 16 * (Math.abs(normal.x) + Math.abs(normal.z)) + 0.0625 + 24 * tilt - 76 * tilt;
  const pos = { x: normal.x * (offset + (curved ? 128 : 0)), y: 76, z: normal.z * (offset + (curved ? 128 : 0)) };
  const input = {
    direction,
    viewAngles: { pitch: 0, yaw: angle },
    buttons: InputButtons.FORWARD | InputButtons.JUMP,
    isPressed: (button: number) => ((InputButtons.FORWARD | InputButtons.JUMP) & button) !== 0,
  };
  return { backend, world, pos, input };
}

describe("ledge grab geometry", () => {
  it.each([0, Math.PI / 4])("grabs an inclined wall with a clear lift path at yaw %s", async (angle) => {
    const { backend, world, pos, input } = await ledge(angle, false, 0.25);
    try {
      const grab = new LedgeGrab();
      expect(world.trace(pos, pos, hull).hit).toBe(false);
      expect(grab.update(pos, { x: 0, y: -100, z: 0 }, input, world, 0, DEFAULT_FPS_MOVEMENT_CONFIG, false)).toBe(true);
    } finally {
      backend.dispose();
    }
  });
  it.each([0, Math.PI / 4, -Math.PI / 4, Math.PI / 2])("grabs a reachable ledge at yaw %s", async (angle) => {
    const { backend, world, pos, input } = await ledge(angle);
    try {
      const grab = new LedgeGrab();
      expect(grab.update(pos, { x: 0, y: -100, z: 0 }, input, world, 0, DEFAULT_FPS_MOVEMENT_CONFIG, false)).toBe(true);
    } finally {
      backend.dispose();
    }
  });

  it("grabs a curved ledge from a diagonal approach", async () => {
    const { backend, world, pos, input } = await ledge(Math.PI / 4, true);
    try {
      const grab = new LedgeGrab();
      expect(grab.update(pos, { x: 0, y: -100, z: 0 }, input, world, 0, DEFAULT_FPS_MOVEMENT_CONFIG, false)).toBe(true);
    } finally {
      backend.dispose();
    }
  });

  it.each([
    [0, false],
    [Math.PI / 4, false],
    [-Math.PI / 4, false],
    [Math.PI / 4, true],
  ] as const)("keeps the full player hull clear during pull-up (yaw=%s, curved=%s)", async (angle, curved) => {
    const { backend, world, pos, input } = await ledge(angle, curved);
    try {
      const grab = new LedgeGrab(),
        vel = { x: 0, y: -100, z: 0 };
      expect(grab.update(pos, vel, input, world, 0, DEFAULT_FPS_MOVEMENT_CONFIG, false)).toBe(true);
      for (let tick = 1; tick <= 90; tick++) {
        grab.update(pos, vel, input, world, tick * 8, DEFAULT_FPS_MOVEMENT_CONFIG, false);
        expect(world.trace(pos, pos, hull).hit, `embedded at pull tick ${tick}`).toBe(false);
      }
      expect(pos.y).toBeGreaterThan(124);
      expect(world.trace(pos, { ...pos, y: pos.y - 4 }, hull).hit).toBe(true);
    } finally {
      backend.dispose();
    }
  });

  it("abandons a newly obstructed pull and suppresses immediate re-grabbing", async () => {
    const { backend, world, pos, input } = await ledge(0);
    try {
      const grab = new LedgeGrab(),
        vel = { x: 0, y: -100, z: 0 };
      expect(grab.update(pos, vel, input, world, 0, DEFAULT_FPS_MOVEMENT_CONFIG, false)).toBe(true);
      grab.update(pos, vel, input, world, 128, DEFAULT_FPS_MOVEMENT_CONFIG, false);
      expect(grab.state).toBe("pulling");
      const obstacle = vi.spyOn(world, "trace").mockReturnValue({ hit: true, fraction: 0 });
      expect(grab.update(pos, vel, input, world, 136, DEFAULT_FPS_MOVEMENT_CONFIG, false)).toBe(false);
      expect(grab.state).toBe("none");
      expect(vel.y).toBeLessThanOrEqual(-100);
      obstacle.mockRestore();
      expect(grab.update(pos, vel, input, world, 144, DEFAULT_FPS_MOVEMENT_CONFIG, false)).toBe(false);
      expect(grab.state).toBe("none");
    } finally {
      backend.dispose();
    }
  });

  it("rejects an obstructed route even when the destination has room", async () => {
    const { backend, world, pos, input } = await ledge(0);
    try {
      const original = world.trace.bind(world);
      vi.spyOn(world, "trace").mockImplementation((start, end, bounds, mask) =>
        bounds && start.y === end.y && (start.x !== end.x || start.z !== end.z)
          ? { hit: true, fraction: 0.5, normal: { x: 0, y: 0, z: -1 } }
          : original(start, end, bounds, mask),
      );
      const grab = new LedgeGrab(),
        vel = { x: 0, y: -100, z: 0 };
      expect(grab.update(pos, vel, input, world, 0, DEFAULT_FPS_MOVEMENT_CONFIG, false)).toBe(false);
      expect(grab.state).toBe("none");
      expect(vel.y).toBe(-100);
    } finally {
      backend.dispose();
    }
  });
});
