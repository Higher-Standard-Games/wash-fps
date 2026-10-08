import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DroppedWeaponInfo } from "../DroppedWeaponRenderer";

/**
 * A dropped weapon out of view is hidden and kept, not thrown away.
 *
 * The server sends every dropped weapon whatever the PVS, so a weapon missing
 * from a snapshot is gone. One that is merely behind a wall stays: rebuilding it
 * on the way back into view loaded the model again and tossed it with a new
 * spin, so it hopped and landed at a new angle.
 */
const pvs = vi.hoisted(() => ({ visible: new Set<number>() }));

vi.mock("../../../../engine/loader/bsp/BspManager", () => ({
  BspManager: {
    getInstance: () => ({
      getPvsCuller: () => ({ isPositionVisible: (at: { x: number }) => pvs.visible.has(at.x) }),
    }),
  },
}));
// No model: the visual's load finds nothing and leaves `mesh` empty.
vi.mock("../../../../engine/loader/AssetPreloader", () => ({
  AssetPreloader: { getInstance: () => ({ hasModel: () => false }) },
}));
vi.mock("../../../../engine/loader/model/ModelLoader", () => ({
  ModelLoader: { getInstance: () => ({ isInitialized: () => true, loadModel: async () => null }) },
}));
vi.mock("../../../../engine/physics/PhysicsSystem", () => ({
  PhysicsSystem: { getInstance: () => ({ removeBody: vi.fn(() => true) }) },
}));
vi.mock("../../world/PickupPrompt", () => ({ hidePickupPrompt: vi.fn(), showPickupPrompt: vi.fn() }));

const { DroppedWeaponRenderer } = await import("../DroppedWeaponRenderer");

interface Visual {
  mesh: { setEnabled(on: boolean): void; position: Vector3 } | null;
  setVisible(on: boolean): void;
  dispose(): void;
}

function renderer() {
  // Demo-style (server transforms) so no pickup prompt or physics is involved.
  const r = new DroppedWeaponRenderer({} as Scene, true);
  const weapons = (r as unknown as { weapons: Map<string, Visual> }).weapons;
  const sync = (ids: Record<string, number>) => {
    const entities = new Map<string, DroppedWeaponInfo>();
    for (const [id, x] of Object.entries(ids)) entities.set(id, { x, y: 0, z: 0, weaponId: "rlauncher" });
    r.syncServerEntities(entities);
  };
  return { r, weapons, sync };
}

afterEach(() => pvs.visible.clear());

describe("dropped weapons and the camera's PVS", () => {
  it("hides a weapon out of view and shows the same one again, with no rebuild", () => {
    const { r, weapons, sync } = renderer();
    pvs.visible.add(100);
    sync({ item_1: 100 });
    const visual = weapons.get("item_1") as Visual;
    const setEnabled = vi.fn();
    visual.mesh = { setEnabled, position: new Vector3(100, 0, 0) };

    pvs.visible.clear();
    sync({ item_1: 100 });
    expect(weapons.get("item_1")).toBe(visual);
    expect(setEnabled).toHaveBeenLastCalledWith(false);

    pvs.visible.add(100);
    sync({ item_1: 100 });
    expect(weapons.get("item_1")).toBe(visual);
    expect(setEnabled).toHaveBeenLastCalledWith(true);
    visual.mesh = null;
    r.dispose();
  });

  it("disposes a weapon the server stopped sending", () => {
    const { r, weapons, sync } = renderer();
    sync({ item_1: 100, item_2: 200 });
    const gone = weapons.get("item_2") as Visual;
    const dispose = vi.spyOn(gone, "dispose");

    sync({ item_1: 100 });

    expect(dispose).toHaveBeenCalled();
    expect(weapons.has("item_2")).toBe(false);
    expect(weapons.has("item_1")).toBe(true);
    r.dispose();
  });

  it("lets go of physics once settled, so the weapon rests where the server has it", () => {
    vi.useFakeTimers();
    try {
      const { r, weapons, sync } = renderer();
      sync({ item_1: 100 });
      const visual = weapons.get("item_1") as unknown as Visual & { scheduleSettleCheck(): void };
      const mesh = {
        name: "dropped_item_1",
        position: new Vector3(90, 0, 0),
        setEnabled: vi.fn(),
        isDisposed: () => false,
        physicsBody: {
          getLinearVelocity: () => Vector3.Zero(),
          setLinearVelocity: vi.fn(),
          setAngularVelocity: vi.fn(),
          dispose: vi.fn(() => {
            mesh.physicsBody = null as never;
          }),
        },
      };
      visual.mesh = mesh;
      visual.scheduleSettleCheck();
      vi.advanceTimersByTime(500);

      // A stopped body still in the world had Havok write its place over the
      // lerp every step: it could rest away from the pickup spot (W3).
      expect(mesh.physicsBody).toBeNull();
      for (let i = 0; i < 60; i++) sync({ item_1: 100 });
      expect(mesh.position.x).toBeCloseTo(100, 1);
      visual.mesh = null;
      r.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tosses a weapon first seen as it drops, not one first seen after it landed", () => {
    const { r, weapons, sync } = renderer();
    sync({ item_0: 0 });
    const proto = Object.getPrototypeOf(weapons.get("item_0"));
    const loadModel = vi.spyOn(proto, "loadModel");
    const now = vi.spyOn(performance, "now");
    try {
      const toss = new Vector3(0, 200, 300);
      now.mockReturnValue(1000);
      r.stashVelocity("item_1", toss);
      r.stashVelocity("item_2", toss);
      now.mockReturnValue(1050);
      sync({ item_0: 0, item_1: 100 });
      expect(loadModel).toHaveBeenLastCalledWith(expect.anything(), toss);

      // Seen four seconds on, it has landed: thrown again, it hopped (W7).
      now.mockReturnValue(5000);
      sync({ item_0: 0, item_1: 100, item_2: 200 });
      expect(loadModel).toHaveBeenLastCalledWith(expect.anything(), undefined);
    } finally {
      loadModel.mockRestore();
      now.mockRestore();
      r.dispose();
    }
  });
});
