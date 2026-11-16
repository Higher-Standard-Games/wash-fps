import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HitSpatter } from "../HitSpatter";

const collision = vi.hoisted(() => ({ trace: vi.fn() }));
vi.mock("../../../../engine/physics/CollisionManager", () => ({
  getCollisionManager: () => ({ isInitialized: () => true, trace: collision.trace }),
}));

describe("blood's floor", () => {
  let scene: Scene | undefined;
  afterEach(() => {
    HitSpatter.getInstance().dispose();
    scene?.dispose();
  });

  it("is found by a point trace, so splats lie on it rather than a player's height above", () => {
    scene = new Scene(new NullEngine());
    const spatter = HitSpatter.getInstance();
    spatter.init(scene);
    collision.trace.mockReturnValue({ fraction: 0.5, endPos: new Vector3(0, 12, 0), startSolid: false });
    const floor = (spatter as unknown as { floorUnder(x: number, y: number, z: number): number }).floorUnder(0, 140, 0);
    expect(floor).toBe(12);
    // Without a height the backend sweeps a player-sized column, and stops with its feet on the floor
    expect(collision.trace.mock.calls[0][2]).toMatchObject({ radius: 0, height: 0 });
  });
});
