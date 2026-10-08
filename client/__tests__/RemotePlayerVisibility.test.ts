import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlayerModelInstance } from "../../../../engine/animation/PlayerModelManager";

/**
 * A remote player's body and hand weapon are switched off and on together.
 *
 * The weapon hangs off a hand bone, not the model's anchor, so switching the
 * anchor on does not bring it back. PVS switched both off, and only the body
 * came back: a player who stepped behind a wall reappeared empty-handed (R1).
 * A player killed while switched off was handed to the ragdoll that way, and
 * the ragdoll draws what it is given: an invisible corpse (R4, E2).
 */
const pvs = vi.hoisted(() => ({ visible: true }));

vi.mock("../../../../engine/loader/bsp/BspManager", () => ({
  BspManager: {
    getInstance: () => ({ getPvsCuller: () => ({ isPositionVisible: () => pvs.visible }) }),
  },
}));

const { RemotePlayerRenderer } = await import("../RemotePlayerRenderer");

interface Internals {
  hitboxes: Map<string, unknown>;
  modelManager: unknown;
  deadEntities: Map<string, number>;
  _hiddenEntityId: string | null;
  hiddenCorpse: PlayerModelInstance | null;
  applyHitboxVisualStyle(): void;
  updateWeaponModel(): void;
  _animDebug(): void;
  updateModel(hitbox: unknown, interp: unknown, entityId: string, animationTimeScale: number): void;
  applyEntityLod(hitbox: unknown, camera: null, radiusSq: number): void;
  detachModel(entityId: string): PlayerModelInstance | null;
  setHiddenEntity(entityId: string | null): void;
}

let scene: Scene;

function setup() {
  scene = new Scene(new NullEngine());
  const anchor = new TransformNode("anchor", scene);
  const body = new Mesh("body", scene);
  body.parent = anchor;
  // Parented elsewhere, as attachToBone leaves it: not under the anchor.
  const weapon = new Mesh("weapon", scene);
  const model = { anchor, mesh: body, skeleton: null, attachedWeapon: weapon } as unknown as PlayerModelInstance;
  const hitbox = { mesh: new Mesh("hitbox", scene), model, weaponRoot: weapon };

  const renderer = Object.create(RemotePlayerRenderer.prototype) as Internals;
  renderer.hitboxes = new Map([["player_2", hitbox]]);
  renderer.deadEntities = new Map();
  renderer._hiddenEntityId = null;
  renderer.hiddenCorpse = null;
  renderer.modelManager = { resetRootMotion: vi.fn(), setAnimationActive: vi.fn(), playAnimation: vi.fn() };
  renderer._animDebug = vi.fn();
  renderer.applyHitboxVisualStyle = vi.fn();
  renderer.updateWeaponModel = vi.fn();

  const frame = () => {
    renderer.updateModel(hitbox, { x: 0, y: 0, z: 0, yaw: 0, crouching: false, sliding: false }, "player_2", 1);
    renderer.applyEntityLod(hitbox, null, 0);
  };
  return { renderer, anchor, weapon, frame };
}

describe("remote player visibility", () => {
  afterEach(() => {
    pvs.visible = true;
    scene.getEngine().dispose();
  });

  it("brings the hand weapon back with the body after PVS culled them", () => {
    const { anchor, weapon, frame } = setup();
    pvs.visible = false;
    frame();
    expect(anchor.isEnabled(false)).toBe(false);
    expect(weapon.isEnabled(false)).toBe(false);

    pvs.visible = true;
    frame();
    expect(anchor.isEnabled(false)).toBe(true);
    expect(weapon.isEnabled(false)).toBe(true);
  });

  it("hands a player killed out of view to the ragdoll switched on", () => {
    const { renderer, anchor, weapon, frame } = setup();
    pvs.visible = false;
    frame();

    const corpse = renderer.detachModel("player_2");
    expect(corpse?.anchor).toBe(anchor);
    expect(anchor.isEnabled(false)).toBe(true);
    expect(weapon.isEnabled(false)).toBe(true);
  });

  it("keeps the corpse of the player we watched hidden until the camera leaves their head", () => {
    const { renderer, anchor, weapon } = setup();
    renderer.setHiddenEntity("player_2");

    renderer.detachModel("player_2");
    expect(anchor.isEnabled(false)).toBe(false);
    expect(weapon.isEnabled(false)).toBe(false);

    renderer.setHiddenEntity("player_3"); // on to the next teammate
    expect(anchor.isEnabled(false)).toBe(true);
    expect(weapon.isEnabled(false)).toBe(true);
  });

  it("leaves a corpse the ragdoll already removed alone", () => {
    const { renderer, anchor } = setup();
    renderer.setHiddenEntity("player_2");
    renderer.detachModel("player_2");
    anchor.dispose();
    expect(() => renderer.setHiddenEntity(null)).not.toThrow();
  });
});
