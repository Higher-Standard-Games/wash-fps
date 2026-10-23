import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { GetEnvironmentBRDFTexture } from "@babylonjs/core/Misc/brdfTextureTools";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MD3LoadResult } from "../../../../engine/loader/model/MD3Loader";
import { parseTags } from "../../../../engine/loader/model/TagsLoader";
import { clearWeaponIdResolver, registerWeaponIdResolver } from "../../../../engine/weapon/WeaponIdResolver";
import { WeaponViewManager } from "../../../../engine/weapon/WeaponViewManager";
import { EntityRegistry } from "../../../../shared/entities/EntityRegistry";
import { BLADE } from "../../shared/entities/definitions/weapons/blade";
import { PLASMAGUN } from "../../shared/entities/definitions/weapons/plasmagun";
import { RIOTGUN } from "../../shared/entities/definitions/weapons/riotgun";
import { VOLTAIC } from "../../shared/entities/definitions/weapons/voltaic";
import { canonicalWeaponId } from "../../shared/entities/definitions/weapons/WeaponsTable";

const imports = vi.hoisted(() => vi.fn());
const muzzleFlash = vi.hoisted(() => vi.fn());
vi.mock("@babylonjs/core/Loading/sceneLoader", () => ({ ImportMeshAsync: imports }));
vi.mock("../../../../engine/weapon/HitscanEffects", () => ({
  getHitscanEffects: () => ({
    init: vi.fn(),
    stopBeam: vi.fn(),
    stopLightning: vi.fn(),
    setMuzzleAnchorResolver: vi.fn(),
    fireMuzzleFlash: muzzleFlash,
  }),
}));
vi.mock("../../../../engine/weapon/ProjectileManager", () => ({ getProjectileManager: () => ({ init: vi.fn() }) }));
vi.mock("../../../../engine/loader/model/TagsLoader", async (original) => ({
  ...(await original<typeof import("../../../../engine/loader/model/TagsLoader")>()),
  loadTags: async () => parseTags('tag "tag_barrel2" "tag_barrel" 0 0 0 0 0 0'),
}));

type Internals = {
  currentWeapon: MD3LoadResult;
  muzzleSocket: TransformNode;
  weaponBarrels: { barrels: { root: TransformNode }[] };
};
let engine: NullEngine, scene: Scene, view: WeaponViewManager;
function imported(file: string, target: Scene) {
  const root = new Mesh("__root__", target);
  root.scaling.set(1, 1, -1);
  const body = MeshBuilder.CreateBox(file, {}, target);
  body.parent = root;
  const material = new PBRMaterial(file, target);
  material.albedoTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, target);
  body.material = material;
  const muzzle = new TransformNode("tag_flash", target);
  muzzle.parent = root;
  muzzle.position.z = 2;
  const socket = new TransformNode("tag_barrel2", target);
  socket.parent = root;
  socket.position.set(3, 4, 5);
  const skeleton = new Skeleton("weaponRig", "weaponRig", target);
  const bone = new Bone("tag_barrel2", skeleton, null, Matrix.Identity());
  bone.linkTransformNode(socket);
  body.skeleton = skeleton;
  return { meshes: [root, body], transformNodes: [muzzle, socket], skeletons: [skeleton], animationGroups: [] };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const internals = () => view as unknown as Internals;
const waitForBarrels = () => vi.waitFor(() => expect(internals().weaponBarrels.barrels).toHaveLength(2));
const counts = () => [
  scene.meshes.length,
  scene.materials.length,
  scene.textures.length,
  scene.skeletons.length,
  scene.transformNodes.length,
];
beforeEach(() => {
  registerWeaponIdResolver(canonicalWeaponId);
  engine = new NullEngine();
  scene = new Scene(engine);
  view = new WeaponViewManager();
  view.init(scene, new FreeCamera("main", Vector3.Zero(), scene));
  EntityRegistry.getInstance().clear();
  for (const weapon of [PLASMAGUN, RIOTGUN, BLADE]) EntityRegistry.getInstance().register(weapon);
  imports.mockReset();
  muzzleFlash.mockReset();
  imports.mockImplementation(async (file, target) => imported(file, target));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 404 })),
  );
});
afterEach(async () => {
  clearWeaponIdResolver();
  view.dispose();
  await settle();
  scene.dispose();
  engine.dispose();
  EntityRegistry.getInstance().clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("first-person prepared model sources", () => {
  it("normalizes Washoi compatibility IDs when loading and switching views", async () => {
    EntityRegistry.getInstance().register(VOLTAIC);
    expect(await view.loadWeapon("lasergun")).toBe(true);
    expect(view.getDisplayedWeaponId()).toBe("voltaic");
    expect((view as unknown as { currentWeaponDef: unknown }).currentWeaponDef).toBe(VOLTAIC);
    expect(await view.loadWeapon("plasmagun")).toBe(true);
    expect(view.getDisplayedWeaponId()).toBe("plasmagun");
    await view.switchWeaponAnimated("lasergun");
    expect(view.getDisplayedWeaponId()).toBe("voltaic");
  });
  it("adds the longer-lived teal tip spark only to blade swings", async () => {
    await view.loadWeapon("blade");
    const tip = new Vector3(2, 3, 5);
    vi.spyOn(view as unknown as { getBladeTipWorldPosition(): Vector3 }, "getBladeTipWorldPosition").mockReturnValue(
      tip,
    );
    view.presentFire();
    expect(muzzleFlash).toHaveBeenCalledTimes(2);
    expect(muzzleFlash.mock.calls[1][0]).toMatchObject({ position: tip, duration: 0.16, scale: 0.4 });
    expect(muzzleFlash.mock.calls[1][0].color.g).toBe(1);
    muzzleFlash.mockClear();
    view.presentFire({ isProjectileFire: true });
    expect(muzzleFlash).toHaveBeenCalledTimes(1);
    expect(
      internals()
        .currentWeapon.root.getDescendants()
        .some((node) => node.name === "tag_blade_tip"),
    ).toBe(true);
  });
  it("guards cloned WebGPU view/barrel caps against later glTF raises and disables shader hot swapping", async () => {
    Object.defineProperty(engine, "isWebGPU", { value: true, configurable: true });
    vi.spyOn(engine, "getCaps").mockReturnValue({ ...engine.getCaps(), texelFetch: true });
    await view.loadWeapon("plasmagun");
    await waitForBarrels();
    const main = internals().currentWeapon.meshes.find((mesh) => mesh.material)!.material as PBRMaterial;
    expect(main.maxSimultaneousLights).toBe(2);
    expect(main.allowShaderHotSwapping).toBe(false);
    main.maxSimultaneousLights = 99;
    expect(main.maxSimultaneousLights).toBe(2);
    for (const barrel of internals().weaponBarrels.barrels) {
      const material = barrel.root.getChildMeshes(false)[0].material as PBRMaterial;
      expect(material.maxSimultaneousLights).toBe(4);
      expect(material.allowShaderHotSwapping).toBe(false);
      material.maxSimultaneousLights = 99;
      expect(material.maxSimultaneousLights).toBe(4);
    }
  });

  it("keeps another view's model, material and camera pair intact when this view is disposed", async () => {
    await view.loadWeapon("riotgun");
    const liveWeapon = internals().currentWeapon;
    const liveMaterial = liveWeapon.meshes.find((mesh) => mesh.material)!.material!;
    const demo = new WeaponViewManager();
    demo.init(scene, new FreeCamera("demo", Vector3.Zero(), scene));
    try {
      await demo.loadWeapon("riotgun");
      demo.dispose();
      await settle();
      view.reassertCameras();
      expect(liveWeapon.root.isDisposed()).toBe(false);
      expect(scene.materials.includes(liveMaterial)).toBe(true);
      expect(view.isWeaponModelLoaded).toBe(true);
      expect(imports).toHaveBeenCalledTimes(2); // Sources are view-owned, not global.
    } finally {
      demo.dispose();
    }
  });

  it("reloads a source invalidated by map cleanup and retries failed imports", async () => {
    imports.mockRejectedValueOnce(new Error("missing file"));
    expect(await view.loadWeapon("riotgun")).toBe(false);
    expect(await view.loadWeapon("riotgun")).toBe(true);
    for (const mesh of [...scene.meshes]) mesh.dispose(false, true);
    expect(await view.loadWeapon("riotgun")).toBe(true);
    expect(view.isWeaponModelLoaded).toBe(true);
    expect(imports).toHaveBeenCalledTimes(3);
  });

  it("imports each main/barrel source once across switches, preserves the rig/tags and bounds resources", async () => {
    expect(await view.loadWeapon("plasmagun")).toBe(true);
    await waitForBarrels();
    const first = internals().currentWeapon;
    const geometry = first.meshes.find((mesh) => mesh.getTotalVertices() > 0)!.geometry;
    expect(first.root.getChildMeshes(false)[0].scaling.z).toBe(-1);
    expect(first.root.getChildMeshes(false)[0].rotation.y).toBeCloseTo(-Math.PI / 2);
    expect(internals().muzzleSocket.isDescendantOf(first.root)).toBe(true);
    const barrels = internals().weaponBarrels.barrels;
    expect(barrels).toHaveLength(2);
    expect(barrels.map((barrel) => barrel.root.position.asArray())).toEqual([
      [3, 4, 1],
      [3, 4, 5],
    ]);
    expect(barrels[0].root.getChildMeshes(false)[0].material).not.toBe(
      barrels[1].root.getChildMeshes(false)[0].material,
    );
    for (let i = 0; i < 2; ++i) {
      await view.loadWeapon("riotgun");
      await view.loadWeapon("plasmagun");
      await waitForBarrels();
    }
    const warmed = counts();
    for (let i = 0; i < 5; ++i) {
      await view.loadWeapon("riotgun");
      await view.loadWeapon("plasmagun");
      await waitForBarrels();
    }
    expect(counts()).toEqual(warmed);
    expect(imports.mock.calls.map(([file]) => file).sort()).toEqual([
      "plasmagun.glb",
      "plasmagun_barrel.glb",
      "riotgun.glb",
    ]);
    expect(first.root.isDisposed()).toBe(true);
    const active = internals().currentWeapon;
    expect(active.meshes.find((mesh) => mesh.getTotalVertices() > 0)!.geometry).toBe(geometry);
    expect(
      active.meshes
        .find((mesh) => mesh.skeleton)!
        .skeleton!.bones[0].getTransformNode()!
        .isDescendantOf(active.root),
    ).toBe(true);
    view.dispose();
    await settle();
    expect(scene.meshes).toHaveLength(0);
    expect(scene.skeletons).toHaveLength(0);
    expect(scene.textures.filter((texture) => texture !== GetEnvironmentBRDFTexture(scene))).toHaveLength(0);
  });

  it("deduplicates A-B-A in-flight requests and prevents the stale request from replacing the latest weapon", async () => {
    let complete!: (result: ReturnType<typeof imported>) => void;
    const waiting = new Promise<ReturnType<typeof imported>>((resolve) => {
      complete = resolve;
    });
    imports.mockImplementation((file, target) =>
      file === "plasmagun.glb" ? waiting : Promise.resolve(imported(file, target)),
    );
    const first = view.loadWeapon("plasmagun");
    expect(await view.loadWeapon("riotgun")).toBe(true);
    const latest = view.loadWeapon("plasmagun");
    complete(imported("plasmagun.glb", scene));
    expect(await first).toBe(false);
    expect(await latest).toBe(true);
    await waitForBarrels();
    expect(imports.mock.calls.filter(([file]) => file === "plasmagun.glb")).toHaveLength(1);
    expect(view.getWeaponInfo()?.name).toBe("plasmagun");
  });

  it("clear cancels an in-flight main load without discarding the reusable source", async () => {
    let complete!: (result: ReturnType<typeof imported>) => void;
    imports.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const load = view.loadWeapon("riotgun");
    view.clear();
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    complete(imported("riotgun.glb", scene));
    expect(await load).toBe(false);
    expect(view.isWeaponModelLoaded).toBe(false);
    expect(await view.loadWeapon("riotgun")).toBe(true);
    expect(imports).toHaveBeenCalledTimes(1);
  });

  it("re-init retires an in-flight source and preserves the replacement camera pair", async () => {
    let complete!: (result: ReturnType<typeof imported>) => void;
    imports.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const load = view.loadWeapon("riotgun");
    const camera = new FreeCamera("replacement", Vector3.Zero(), scene);
    view.init(scene, camera);
    const pair = [...scene.activeCameras!];
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    complete(imported("riotgun.glb", scene));
    expect(await load).toBe(false);
    expect(view.isWeaponModelLoaded).toBe(false);
    expect(scene.activeCameras?.map((item) => item.uniqueId)).toEqual(pair.map((item) => item.uniqueId));
    expect(scene.meshes).toHaveLength(0);
    expect(scene.skeletons).toHaveLength(0);
  });

  it("reuses blade appearance while keeping hidden-on-death state and powerup outlines", async () => {
    imports.mockImplementation(async (file, target) => {
      const result = imported(file, target);
      if (file === "arc_blade.glb") {
        const material = result.meshes[1].material as PBRMaterial;
        material.emissiveTexture = RawTexture.CreateRGBATexture(new Uint8Array([0, 255, 255, 255]), 1, 1, target);
        material.metallicTexture = material.albedoTexture;
        material.bumpTexture = material.albedoTexture;
        material.emissiveIntensity = 10;
      }
      return result;
    });
    view.setVisible(false);
    expect(await view.loadWeapon("blade")).toBe(true);
    expect(internals().currentWeapon.root.isEnabled()).toBe(false);
    expect(
      internals()
        .currentWeapon.meshes.find((mesh) => mesh.material)!
        .material!.getClassName(),
    ).toBe("PBRMaterial");
    const bladeMaterial = internals().currentWeapon.meshes.find((mesh) => mesh.material)!.material as PBRMaterial;
    expect(bladeMaterial.emissiveTexture).toBeTruthy();
    expect(bladeMaterial.metallicTexture).toBeTruthy();
    expect(bladeMaterial.bumpTexture).toBeTruthy();
    expect(bladeMaterial.emissiveIntensity).toBe(10);
    const fill = scene.getLightByName("bladeLight")!;
    const bladeMesh = internals().currentWeapon.meshes.find((mesh) => mesh.material)!;
    expect(bladeMesh.lightSources[0]).toBe(fill);
    expect(fill.canAffectMesh(bladeMesh)).toBe(true);
    const worldMesh = MeshBuilder.CreateBox("world", {}, scene);
    expect(fill.canAffectMesh(worldMesh)).toBe(false);
    view.setPowerupOutlineOverride(true, new Color3(1, 0.3, 0), 0.3);
    await view.loadWeapon("riotgun");
    expect(fill.isEnabled()).toBe(false);
    await view.loadWeapon("blade");
    expect(fill.isEnabled()).toBe(true);
    expect(internals().currentWeapon.meshes.find((mesh) => mesh.material)!.lightSources[0]).toBe(fill);
    expect(fill.canAffectMesh(internals().currentWeapon.meshes.find((mesh) => mesh.material)!)).toBe(true);
    expect(internals().currentWeapon.meshes.every((mesh) => mesh.renderOutline)).toBe(true);
    expect(internals().currentWeapon.root.getChildMeshes(false)[0].rotation.x).toBeCloseTo(Math.PI);
    expect(imports.mock.calls.filter(([file]) => file === "arc_blade.glb")).toHaveLength(1);
  });

  it("cancels a barrel import on disposal and leaves no imported resources", async () => {
    let complete!: (result: ReturnType<typeof imported>) => void;
    imports.mockImplementation((file, target) =>
      file.includes("_barrel")
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : Promise.resolve(imported(file, target)),
    );
    await view.loadWeapon("plasmagun");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    view.dispose();
    complete(imported("plasmagun_barrel.glb", scene));
    await vi.waitFor(() => {
      expect(scene.meshes).toHaveLength(0);
      expect(scene.skeletons).toHaveLength(0);
      expect(scene.textures.filter((texture) => texture !== GetEnvironmentBRDFTexture(scene))).toHaveLength(0);
    });
  });
});
