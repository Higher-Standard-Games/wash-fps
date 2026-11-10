import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => ({ count: 0, scene: null as unknown as import("@babylonjs/core/scene").Scene }));

vi.mock("../AmmoIconTexture", () => ({
  loadAmmoIconTexture: async (path: string) => {
    loads.count++;
    return new Texture(`data:${path}`, loads.scene);
  },
}));

const { addAmmoBoxSymbols } = await import("../AmmoBoxSymbols");

describe("ammo box symbols", () => {
  it("builds a symbol again when its texture went with the previous map", async () => {
    loads.scene = new Scene(new NullEngine());
    const box = () => MeshBuilder.CreateBox("ammo", { size: 1 }, loads.scene);
    const symbolOf = (mesh: ReturnType<typeof box>) => mesh.getChildMeshes()[0].material!;

    const first = box();
    await addAmmoBoxSymbols(first, "ammo_lasers");
    const second = box();
    await addAmmoBoxSymbols(second, "ammo_lasers");
    // Boxes of one map share the symbol
    expect(symbolOf(second)).toBe(symbolOf(first));
    expect(loads.count).toBe(1);

    // The map's package textures are disposed with it; the next map's box gets a working symbol
    const stale = symbolOf(first);
    first.dispose();
    second.dispose();
    for (const texture of stale.getActiveTextures()) texture.dispose();
    const next = box();
    await addAmmoBoxSymbols(next, "ammo_lasers");
    const fresh = symbolOf(next);
    expect(fresh).not.toBe(stale);
    expect(fresh.getActiveTextures().every((texture) => texture.getInternalTexture() !== null)).toBe(true);
    expect(loads.count).toBe(2);
    loads.scene.getEngine().dispose();
  });
});
