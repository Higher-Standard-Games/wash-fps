import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlayerModelInstance } from "../../../../engine/animation/PlayerModelManager";
import { WEAPONS } from "../../../../shared/entities/definitions/weapons/WeaponsTable";

/**
 * A remote player's weapon changes leave nothing behind (NullEngine).
 *
 * Each change loads a fresh model and moves its meshes onto the hand. The
 * loader's root, glTF's `__root__`, the empty nodes between and the animation
 * groups stayed in the scene for good, switched off, so a match of weapon
 * switching left thousands that Babylon still walks every frame (R5).
 */
const scene = vi.hoisted(() => ({ current: null as unknown as import("@babylonjs/core/scene").Scene, loads: 0 }));

vi.mock("../../../../engine/loader/model/ModelLoader", () => ({
  ModelLoader: {
    getInstance: () => ({
      isInitialized: () => true,
      loadModel: async () => {
        scene.loads++;
        const root = new TransformNode("__root__", scene.current);
        const between = new TransformNode("RootNode", scene.current);
        between.parent = root;
        const gun = MeshBuilder.CreateBox("gun", { size: 1 }, scene.current);
        gun.material = new StandardMaterial("gun_mat", scene.current);
        gun.parent = between;
        const idle = new AnimationGroup("idle", scene.current);
        return { root, meshes: [gun], animationGroups: [idle], skeletons: [] };
      },
    }),
  },
}));

const { RemotePlayerRenderer } = await import("../RemotePlayerRenderer");

interface Internals {
  scene: Scene;
  hitboxes: Map<string, unknown>;
  deadEntities: Map<string, number>;
  enemyWeapons: Map<string, string>;
  updateWeaponModel(hitbox: unknown, inst: PlayerModelInstance, entityId: string): void;
  attachShowcaseWeapon(inst: PlayerModelInstance, weaponId: string): Promise<void>;
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("remote weapon changes", () => {
  afterEach(() => {
    scene.current.getEngine().dispose();
    vi.restoreAllMocks();
    scene.loads = 0;
  });

  it("leave the scene's nodes, meshes, materials and animation groups where they were", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    scene.current = new Scene(new NullEngine());
    const anchor = new TransformNode("anchor", scene.current);
    const body = MeshBuilder.CreateBox("body", { size: 1 }, scene.current);
    body.parent = anchor;
    const inst = { anchor, mesh: body, skeleton: null, attachedWeapon: null } as unknown as PlayerModelInstance;
    const hitbox = { model: inst, weaponRoot: null, weaponMuzzle: null, currentWeaponId: "" };

    const renderer = Object.create(RemotePlayerRenderer.prototype) as Internals;
    renderer.scene = scene.current;
    renderer.hitboxes = new Map([["player_2", hitbox]]);
    renderer.deadEntities = new Map();
    renderer.enemyWeapons = new Map();

    const [a, b] = Object.entries(WEAPONS)
      .filter(([, def]) => def.modelPath)
      .map(([id]) => id);
    const counts = () => {
      const s = scene.current;
      return [s.transformNodes.length, s.meshes.length, s.materials.length, s.animationGroups.length];
    };

    let after: number[] = [];
    for (let change = 0; change < 20; change++) {
      renderer.enemyWeapons.set("player_2", change % 2 ? a : b);
      renderer.updateWeaponModel(hitbox, inst, "player_2");
      await settle();
      if (change === 1) after = counts();
    }
    expect(hitbox.weaponRoot).not.toBeNull();
    expect(counts()).toEqual(after);
    expect(scene.loads).toBe(2); // One import per distinct path, not twenty switches.
  });

  it("rejects the old A load after A→B→A and attaches only the latest instance", async () => {
    scene.current = new Scene(new NullEngine());
    const anchor = new TransformNode("anchor", scene.current);
    const body = MeshBuilder.CreateBox("body", {}, scene.current);
    body.parent = anchor;
    const inst = { anchor, mesh: body, skeleton: null, attachedWeapon: null } as unknown as PlayerModelInstance;
    const hitbox = { model: inst, weaponRoot: null, weaponMuzzle: null, currentWeaponId: "" };
    const renderer = Object.create(RemotePlayerRenderer.prototype) as Internals;
    Object.assign(renderer, {
      scene: scene.current,
      hitboxes: new Map([["player_2", hitbox]]),
      deadEntities: new Map(),
      enemyWeapons: new Map(),
    });
    const [a, b] = Object.entries(WEAPONS)
      .filter(([, def]) => def.modelPath)
      .map(([id]) => id);
    for (const weapon of [a, b, a]) {
      renderer.enemyWeapons.set("player_2", weapon);
      renderer.updateWeaponModel(hitbox, inst, "player_2");
    }
    await vi.waitFor(() => expect(scene.loads).toBe(2));
    await settle();
    expect(scene.loads).toBe(2);
    expect(hitbox.currentWeaponId).toBe(a);
    expect(scene.current.meshes.filter((mesh) => mesh.name === "gun" && mesh.isEnabled())).toEqual([hitbox.weaponRoot]);
    expect(inst.attachedWeapon).toBe(hitbox.weaponRoot);
  });

  it("leaves nothing when the showcase ended before the winner's gun loaded", async () => {
    scene.current = new Scene(new NullEngine());
    const anchor = new TransformNode("anchor", scene.current);
    const body = MeshBuilder.CreateBox("body", { size: 1 }, scene.current);
    body.parent = anchor;
    const inst = { anchor, mesh: body, skeleton: null, attachedWeapon: null } as unknown as PlayerModelInstance;
    const renderer = Object.create(RemotePlayerRenderer.prototype) as Internals;
    renderer.scene = scene.current;
    const weaponId = Object.entries(WEAPONS).find(([, def]) => def.modelPath)![0];

    const load = renderer.attachShowcaseWeapon(inst, weaponId);
    anchor.dispose(); // next warmup: the showcase model goes
    await load;

    // The gun was attached to the disposed model and stayed in the scene (S5).
    const s = scene.current;
    expect([s.transformNodes.length, s.meshes.length, s.materials.length, s.animationGroups.length]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(inst.attachedWeapon).toBeNull();
  });
});
