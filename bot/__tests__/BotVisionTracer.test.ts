import { describe, expect, it } from "vitest";
import type { BspFile } from "../../../../engine/loader/bsp/BspLoader";
import { SweepBackendAdapter } from "../../../../engine/physics/SweepBackendAdapter";
import { SweepCollisionBackend } from "../../../../engine/physics/SweepCollisionBackend";
import type { AABB, TraceResult } from "../../../../shared/collision/CollisionWorld";
import { SharedCollisionWorld } from "../../../../shared/collision/SharedCollisionWorld";
import { NullCollisionWorld } from "../../../../shared/collision/CollisionWorld";
import type { Vec3 } from "../BotGameState";
import { BotVisionTracer } from "../BotVisionTracer";

interface Box {
  min: Vec3;
  max: Vec3;
}

/** Solid boxes, traced with the moving box swept (slab test on boxes grown by the bounds). */
class BoxWorld extends NullCollisionWorld {
  constructor(private readonly boxes: Box[]) {
    super();
  }

  override trace(start: Vec3, end: Vec3, bounds?: AABB): TraceResult {
    let best: TraceResult = { hit: false, fraction: 1 };
    for (const box of this.boxes) {
      const min = {
        x: box.min.x - (bounds?.max.x ?? 0),
        y: box.min.y - (bounds?.max.y ?? 0),
        z: box.min.z - (bounds?.max.z ?? 0),
      };
      const max = {
        x: box.max.x - (bounds?.min.x ?? 0),
        y: box.max.y - (bounds?.min.y ?? 0),
        z: box.max.z - (bounds?.min.z ?? 0),
      };
      let enter = 0;
      let exit = 1;
      let normal: Vec3 = { x: 0, y: 0, z: 0 };
      let missed = false;
      for (const axis of ["x", "y", "z"] as const) {
        const d = end[axis] - start[axis];
        if (Math.abs(d) < 1e-9) {
          if (start[axis] < min[axis] || start[axis] > max[axis]) missed = true;
          continue;
        }
        let t0 = (min[axis] - start[axis]) / d;
        let t1 = (max[axis] - start[axis]) / d;
        let sign = -1;
        if (t0 > t1) {
          [t0, t1] = [t1, t0];
          sign = 1;
        }
        if (t0 > enter) {
          enter = t0;
          normal = { x: 0, y: 0, z: 0, [axis]: sign };
        }
        exit = Math.min(exit, t1);
      }
      if (missed || enter > exit || enter >= best.fraction) continue;
      best = { hit: true, fraction: Math.max(0, enter - 1e-4), normal };
    }
    return best;
  }
}

/**
 * The same boxes as a real brush map, for the movement code: it moves with
 * the collision backend's step-slide, not with traces alone. Quake is Z-up,
 * so a game (x, y, z) box is the brush (x, z, y).
 */
async function brushWorld(boxes: Box[]) {
  const planes: { normal: number[]; dist: number }[] = [];
  const brushes: { firstSide: number; numSides: number; shaderIndex: number }[] = [];
  for (const b of boxes) {
    brushes.push({ firstSide: planes.length, numSides: 6, shaderIndex: 0 });
    planes.push(
      { normal: [1, 0, 0], dist: b.max.x },
      { normal: [-1, 0, 0], dist: -b.min.x },
      { normal: [0, 1, 0], dist: b.max.z },
      { normal: [0, -1, 0], dist: -b.min.z },
      { normal: [0, 0, 1], dist: b.max.y },
      { normal: [0, 0, -1], dist: -b.min.y },
    );
  }
  const bsp = {
    header: { isFBSP: false },
    entities: [],
    models: [],
    textures: [{ name: "solid", contentFlags: 1, surfaceFlags: 0 }],
    planes,
    brushes,
    brushSides: planes.map((_, planeIndex) => ({ planeIndex, shaderIndex: 0 })),
    nodes: [{ planeIndex: 0, children: [-1, -1] }],
    leafs: [{ firstLeafBrush: 0, numLeafBrushes: brushes.length, firstLeafFace: 0, numLeafFaces: 0 }],
    leafBrushes: brushes.map((_, i) => i),
    leafFaces: [],
    faces: [],
    vertices: [],
    meshVerts: [],
  } as unknown as BspFile;
  const backend = new SweepCollisionBackend();
  await backend.init(bsp);
  return { world: new SharedCollisionWorld(new SweepBackendAdapter(backend)), dispose: () => backend.dispose() };
}

/** A floor under everything, its top at y = 0 (origins stand at 24). */
const floor: Box = { min: { x: -5000, y: -64, z: -5000 }, max: { x: 5000, y: 0, z: 5000 } };
const at = (x: number, z: number): Vec3 => ({ x, y: 24, z });
const running = (yaw: number) => ({ x: Math.sin(yaw) * 400, y: 0, z: Math.cos(yaw) * 400 });

function steer(world: BoxWorld, yaw: number, extra: { targetDistance?: number; position?: Vec3; tick?: number } = {}) {
  return new BotVisionTracer(world).steer({
    tick: extra.tick ?? 0,
    position: extra.position ?? at(0, 0),
    velocity: running(yaw),
    grounded: true,
    yaw,
    ...(extra.targetDistance !== undefined ? { targetDistance: extra.targetDistance } : {}),
  });
}

describe("BotVisionTracer", () => {
  it("leaves a clear heading alone in the open", () => {
    const result = steer(new BoxWorld([floor]), 0);
    expect(result).toMatchObject({ yaw: 0, clear: 1, turned: false });
  });

  it("turns off a wall ahead toward the side that is open", () => {
    // A wall across the way, 100 ahead, from x −300 to +40: open to the right (+x)
    const wall: Box = { min: { x: -300, y: 0, z: 100 }, max: { x: 40, y: 200, z: 116 } };
    const result = steer(new BoxWorld([floor, wall]), 0);
    expect(result?.turned).toBe(true);
    expect(result!.yaw).toBeGreaterThan(0);
    expect(result!.clear).toBeGreaterThan(0.9);
  });

  it("does not count a wall beyond the point it is making for", () => {
    const wall: Box = { min: { x: -300, y: 0, z: 150 }, max: { x: 300, y: 200, z: 166 } };
    const result = steer(new BoxWorld([floor, wall]), 0, { targetDistance: 80 });
    expect(result).toMatchObject({ yaw: 0, turned: false });
  });

  it("runs up a ramp rather than round it", () => {
    // A rising surface met head-on reports a normal facing up
    class Ramp extends BoxWorld {
      override trace(start: Vec3, end: Vec3, bounds?: AABB): TraceResult {
        if (bounds && end.z > 60) return { hit: true, fraction: 0.4, normal: { x: 0, y: 0.8, z: -0.6 } };
        return super.trace(start, end, bounds);
      }
    }
    const result = steer(new Ramp([floor]), 0);
    expect(result).toMatchObject({ yaw: 0, turned: false });
  });

  it("keeps off a ledge the way ahead runs out over", () => {
    // Floor only to z = 120 straight ahead; to the right it carries on
    const near: Box = { min: { x: -5000, y: -64, z: -5000 }, max: { x: 5000, y: 0, z: 120 } };
    const right: Box = { min: { x: 60, y: -64, z: 120 }, max: { x: 5000, y: 0, z: 5000 } };
    const result = steer(new BoxWorld([near, right]), 0);
    expect(result?.turned).toBe(true);
    expect(result!.yaw).toBeGreaterThan(0);
  });

  it("leans off a wall close at one side", () => {
    // A wall along the left (−x), 20 units from the hull
    const wall: Box = { min: { x: -60, y: 0, z: -500 }, max: { x: -36, y: 200, z: 500 } };
    const result = steer(new BoxWorld([floor, wall]), 0);
    expect(result?.turned).toBe(false);
    expect(result!.yaw).toBeGreaterThan(0);
    expect(result!.yaw).toBeLessThan(0.25);
  });

  it("keeps the side it chose while that side still runs clear", () => {
    // A wall straight ahead, open both ways: the side chosen first is kept
    const wall: Box = { min: { x: -120, y: 0, z: 100 }, max: { x: 120, y: 200, z: 116 } };
    const world = new BoxWorld([floor, wall]);
    const tracer = new BotVisionTracer(world);
    const ask = (tick: number, x: number) =>
      tracer.steer({ tick, position: at(x, 0), velocity: running(0), grounded: true, yaw: 0 });
    const first = ask(0, 0);
    expect(first?.turned).toBe(true);
    const sign = Math.sign(first!.yaw);
    // A step the other way would make the other side look a little better
    const next = ask(10, -sign * 10);
    expect(Math.sign(next!.yaw)).toBe(sign);
  });

  it("knows a jump climbs a box ahead, and that it cannot climb a tall wall", async () => {
    const box: Box = { min: { x: -200, y: 0, z: 150 }, max: { x: 200, y: 40, z: 600 } };
    const climbable = await brushWorld([floor, box]);
    const wall: Box = { min: { x: -200, y: 0, z: 150 }, max: { x: 200, y: 400, z: 600 } };
    const tall = await brushWorld([floor, wall]);
    try {
      const top = new BotVisionTracer(climbable.world).climbByJump(at(0, 0), running(0), 0);
      expect(top).not.toBeNull();
      expect(top!.y).toBeGreaterThan(24 + 30);
      expect(top!.z).toBeGreaterThan(150);
      expect(new BotVisionTracer(tall.world).climbByJump(at(0, 0), running(0), 0)).toBeNull();
    } finally {
      climbable.dispose();
      tall.dispose();
    }
  });

  it("finds a wall jump beside a wall, and none in the open air", async () => {
    // A tall wall along the right (+x) of a bot flying up past it toward a goal above
    const wall: Box = { min: { x: 30, y: 0, z: -400 }, max: { x: 80, y: 600, z: 400 } };
    const walled = await brushWorld([floor, wall]);
    const open = await brushWorld([floor]);
    try {
      // Against the wall, falling past it
      const flying = { x: 13, y: 150, z: 0 };
      const velocity = { x: 50, y: -50, z: 250 };
      const goal = { x: 0, y: 400, z: 400 };
      expect(new BotVisionTracer(walled.world).wallJumpGain(flying, velocity, 0, goal)).not.toBeNull();
      expect(new BotVisionTracer(open.world).wallJumpGain(flying, velocity, 0, goal)).toBeNull();
    } finally {
      walled.dispose();
      open.dispose();
    }
  });

  it("leaves the feet alone in the air", () => {
    const tracer = new BotVisionTracer(new BoxWorld([floor]));
    expect(tracer.steer({ tick: 0, position: at(0, 0), velocity: running(0), grounded: false, yaw: 0 })).toBeNull();
  });
});
