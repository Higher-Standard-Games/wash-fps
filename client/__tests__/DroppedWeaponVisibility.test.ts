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
});
