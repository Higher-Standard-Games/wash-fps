/**
 * ProjectileManager model cache (NullEngine). Its cached rocket and grenade
 * models were never refreshed: after the scene clear projectiles cloned empty
 * meshes, and after a map load cleared the texture cache they lost their
 * texture. Only the trail and light remained.
 */

import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { getMD3Loader, type MD3LoadResult } from "../../../../engine/loader/model/MD3Loader";
import { PK3Loader } from "../../../../engine/loader/pk3/PK3Loader";
import { ProjectileManager } from "../../../../engine/weapon/ProjectileManager";
import { getEntityRegistry } from "../../../../shared/entities";
import { BLADE_BLAST } from "../../shared/entities/definitions/projectiles/blade_blast";

let engine: NullEngine;
let scene: Scene;
let manager: ProjectileManager;
let createMeshes: MockInstance<ReturnType<typeof getMD3Loader>["createMeshes"]>;

function loadedModel(): MD3LoadResult {
  const root = new TransformNode("md3_rocket", scene);
  const material = new StandardMaterial("rocket_rocket", scene);
  material.diffuseTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
  const mesh = MeshBuilder.CreateBox("rocket_rocket", { size: 4 }, scene);
  mesh.material = material;
  mesh.parent = root;
  return {
    root,
    meshes: [mesh],
    model: {} as MD3LoadResult["model"],
    currentFrame: 0,
    setFrame: () => {},
    getTag: () => null,
  };
}

function bodyVertices(id: string | null): number {
  const node = id ? scene.getTransformNodeByName(id) : null;
  return node?.getChildMeshes().reduce((total, mesh) => total + mesh.getTotalVertices(), 0) ?? 0;
}

const fire = () => manager.spawn("rocket", Vector3.Zero(), new Vector3(0, 0, 1));

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  (ProjectileManager as unknown as { instance?: ProjectileManager }).instance = undefined;
  manager = ProjectileManager.getInstance();
  (manager as unknown as { scene: Scene }).scene = scene;

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(getEntityRegistry(), "get").mockReturnValue({
    id: "rocket",
    modelPath: "models/objects/projectile/rlauncher/rocket_strong.md3",
    speed: 1814,
    lifetime: 10,
  } as never);
  vi.spyOn(PK3Loader.getInstance(), "getFile").mockResolvedValue(new ArrayBuffer(8));
  vi.spyOn(PK3Loader.getInstance(), "hasFile").mockReturnValue(false);
  vi.spyOn(getMD3Loader(), "parseMD3").mockReturnValue({} as never);
  createMeshes = vi.spyOn(getMD3Loader(), "createMeshes").mockImplementation(() => loadedModel());
});

afterEach(() => {
  manager.clear();
  (ProjectileManager as unknown as { instance?: ProjectileManager }).instance = undefined;
  engine.dispose();
  vi.restoreAllMocks();
});

describe("ProjectileManager model cache", () => {
  it("keeps a cached blade projectile body teal when its definition supplies the energy colour", async () => {
    vi.mocked(getEntityRegistry().get).mockReturnValue(BLADE_BLAST);
    await manager.preloadModel("blade_blast");
    const model = createMeshes.mock.results[0].value as MD3LoadResult;
    const material = model.meshes[0].material as StandardMaterial;
    expect(material.emissiveColor.asArray()).toEqual([0.05, 1, 0.9]);
    expect(material.disableLighting).toBe(true);
    expect(material.opacityTexture?.getAlphaFromRGB).toBe(true);
    expect(material.diffuseTexture).toBeNull();
    expect(material.emissiveTexture).toBeNull();
    expect(material.useEmissiveAsIllumination).toBe(false);
    expect(material.alphaMode).toBe(Constants.ALPHA_ADD);
    expect(material.disableDepthWrite).toBe(true);
  });
  it("loads a projectile model again after the scene clear disposed it", async () => {
    await manager.preloadModel("rocket");
    expect(bodyVertices(fire())).toBeGreaterThan(0);

    manager.clear();
    for (const mesh of [...scene.meshes]) mesh.dispose(false, true);

    // The first shots after the clear start one shared reload by themselves.
    fire();
    fire();
    await vi.waitFor(() => expect(createMeshes).toHaveBeenCalledTimes(2));
    await manager.preloadModel("rocket");

    expect(createMeshes).toHaveBeenCalledTimes(2);
    expect(bodyVertices(fire())).toBeGreaterThan(0);
  });

  it("loads a projectile model again after its texture was released", async () => {
    await manager.preloadModel("rocket");
    const model = createMeshes.mock.results[0].value as MD3LoadResult;

    // MapLoader clears the PK3 texture cache on every map load.
    model.meshes[0].material?.getActiveTextures()[0].dispose();
    await manager.preloadModel("rocket");

    expect(createMeshes).toHaveBeenCalledTimes(2);
  });

  it("does not load a renderable model twice", async () => {
    await manager.preloadModel("rocket");
    await manager.preloadModel("rocket");
    fire();

    expect(createMeshes).toHaveBeenCalledTimes(1);
  });
});
