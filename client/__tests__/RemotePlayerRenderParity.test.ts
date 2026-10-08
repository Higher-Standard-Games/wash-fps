// @vitest-environment jsdom

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Animation } from "@babylonjs/core/Animations/animation";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type PlayerModelInstance, PlayerModelManager } from "../../../../engine/animation/PlayerModelManager";
import { Cvar } from "../../../../engine/core/Cvar";
import type { GameState } from "../../../../engine/network/core/GameState";
import { POWERUP_KINDS } from "../../../../shared/items/Powerups";

/**
 * Everything a remote player looks like, frame by frame, held to a recording.
 *
 * B12 makes `RemotePlayerRenderer.render()` cheaper in stages, and each stage
 * must leave every remote player looking exactly as before. This drives the
 * real renderer and the real model manager through a scripted match (8
 * players: running, strafing, crouching, sliding, jumping, a teleport, a death
 * and respawn, weapon and team changes, quad, a followed player, PVS culling,
 * settings changed mid-match) and records, after every frame, what each player
 * looks like: positions and rotations, which nodes are on, the clip and its
 * speed, the style and glow on the materials, and the root-motion reset.
 *
 * The recording in `__fixtures__/remote-render-parity.txt` was taken from the
 * code before the optimisations. A difference is a change someone can see.
 * To take a new one, run with UPDATE_RENDER_PARITY=1, and only for a change
 * that is meant to be visible.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "remote-render-parity.txt");

const world = vi.hoisted(() => ({
  scene: null as unknown as import("@babylonjs/core/scene").Scene,
  /** Positions the camera cannot see this frame, by x band. */
  culled: (_x: number): boolean => false,
}));

vi.mock("../../../../engine/loader/bsp/BspManager", () => ({
  BspManager: {
    getInstance: () => ({
      getPvsCuller: () => ({ isPositionVisible: (at: { x: number }) => !world.culled(at.x) }),
    }),
  },
}));

vi.mock("../../../../engine/loader/model/ModelLoader", () => ({
  ModelLoader: {
    getInstance: () => ({
      isInitialized: () => true,
      loadModel: async () => {
        const root = new TransformNode("__root__", world.scene);
        const gun = MeshBuilder.CreateBox("gun", { size: 1 }, world.scene);
        gun.material = new StandardMaterial("gun_mat", world.scene);
        gun.parent = root;
        const flash = new TransformNode("tag_flash", world.scene);
        flash.parent = gun;
        return { root, meshes: [gun], animationGroups: [], skeletons: [] };
      },
    }),
  },
}));

const { RemotePlayerRenderer } = await import("../RemotePlayerRenderer");
// Loaded now, so a weapon change's dynamic import settles within the frame
// instead of whenever the module system gets to it.
await import("../../../../engine/loader/model/ModelLoader");

/** Every clip the renderer asks for. One that is missing would leave the previous one playing. */
const CLIPS = [
  "idle",
  "walk",
  "run",
  "run_back",
  "walk_back",
  "strafe_l",
  "strafe_r",
  "jump",
  "slide",
  "crouch_walk",
  "crouch_strafe_l",
  "crouch_strafe_r",
  "swim",
  "swim_idle",
  "climb",
  "walljump",
];

/** vanguard.glb's nesting: `__root__ > RootNode > mixamorig:Hips > …`, 65 joints, two skinned meshes. */
const JOINTS = [
  "mixamorig:Hips",
  "mixamorig:Spine",
  "mixamorig:Spine1",
  "mixamorig:Spine2",
  "mixamorig:Neck",
  "mixamorig:Head",
  "mixamorig:HeadTop_End",
  ...["Left", "Right"].flatMap((side) => [
    `mixamorig:${side}Shoulder`,
    `mixamorig:${side}Arm`,
    `mixamorig:${side}ForeArm`,
    `mixamorig:${side}Hand`,
    ...["Thumb", "Index", "Middle", "Ring", "Pinky"].flatMap((finger) =>
      [1, 2, 3].map((n) => `mixamorig:${side}Hand${finger}${n}`),
    ),
    `mixamorig:${side}UpLeg`,
    `mixamorig:${side}Leg`,
    `mixamorig:${side}Foot`,
    `mixamorig:${side}ToeBase`,
    `mixamorig:${side}Toe_End`,
  ]),
].slice(0, 65);

/** Parent of each joint in JOINTS, by name; the spine chain and each limb chain. */
function parentOf(name: string): string | null {
  const index = JOINTS.indexOf(name);
  if (index === 0) return null;
  if (name.endsWith("Shoulder")) return "mixamorig:Spine2";
  if (name.endsWith("UpLeg")) return "mixamorig:Hips";
  const finger = name.match(/^(mixamorig:(?:Left|Right)Hand)([A-Za-z]+)(\d)$/);
  if (finger) return finger[3] === "1" ? finger[1] : `${finger[1]}${finger[2]}${Number(finger[3]) - 1}`;
  if (/Hand$/.test(name)) return name.replace("Hand", "ForeArm");
  return JOINTS[index - 1];
}

/** The real manager with a stand-in model: the instance is built here, everything else is the game's. */
class StandInModelManager extends PlayerModelManager {
  override get isLoaded(): boolean {
    return true;
  }

  override createInstance(id: string, scale = 36): PlayerModelInstance | null {
    const scene = world.scene;
    const anchor = new TransformNode(`anchor_${id}`, scene);
    const mesh = new Mesh(`${id}/__root__`, scene);
    mesh.parent = anchor;
    mesh.scaling.setAll(scale);
    const rootNode = new TransformNode(`${id}/RootNode`, scene);
    rootNode.parent = mesh;

    const skeleton = new Skeleton(`${id}/skeleton`, `${id}/skeleton`, scene);
    const nodes = new Map<string, TransformNode>();
    const bones = new Map<string, Bone>();
    for (const joint of JOINTS) {
      const parent = parentOf(joint);
      const node = new TransformNode(`${id}/${joint}`, scene);
      node.parent = parent ? (nodes.get(parent) as TransformNode) : rootNode;
      node.position.set(0, joint === "mixamorig:Hips" ? 1.061 : 0.1, 0);
      nodes.set(joint, node);
      const bone = new Bone(joint, skeleton, parent ? bones.get(parent) : null, Matrix.Identity());
      bone.linkTransformNode(node);
      bones.set(joint, bone);
    }

    const material = new PBRMaterial(`vanguard_${id}`, scene);
    for (const part of ["Body", "Joints"]) {
      const skinned = MeshBuilder.CreateBox(`${id}/${part}`, { size: 1 }, scene);
      skinned.parent = rootNode;
      skinned.skeleton = skeleton;
      skinned.material = material;
    }
    for (const child of [mesh, ...mesh.getChildMeshes()]) {
      child.setEnabled(true);
      child.isVisible = true;
      child.visibility = 1;
      child.alwaysSelectAsActiveMesh = true;
    }

    const hips = nodes.get("mixamorig:Hips") as TransformNode;
    const anims = CLIPS.map((name, index) => {
      const animation = new Animation(`${name}_hips`, "position.x", 30, Animation.ANIMATIONTYPE_FLOAT);
      animation.setKeys([
        { frame: 0, value: 0 },
        { frame: 30, value: index },
      ]);
      return { name, animations: [{ target: hips, animation }] };
    });

    return {
      id,
      anchor,
      mesh,
      skeleton,
      anims,
      masterGroup: null,
      currentAnim: "",
      oneshotUntil: 0,
      hipsBind: { node: hips, x: hips.position.x, y: hips.position.y, z: hips.position.z },
    } as PlayerModelInstance;
  }
}

// ── The scripted match ───────────────────────────────────────────────

const FRAMES = 96;
const FRAME_MS = 7; // ~144 fps
const SNAPSHOT_MS = 17; // ~60 Hz
const PLAYERS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `player_${n}`);
const QUAD = 1 << POWERUP_KINDS.indexOf("quad");

interface Body {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  crouching: boolean;
  sliding: boolean;
  powerups: number;
}

/** Where each player is at a time, or null while dead. */
function bodyAt(entityId: string, t: number): Body | null {
  const s = t / 1000;
  const base: Body = {
    x: 0,
    y: 24,
    z: 0,
    yaw: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: true,
    crouching: false,
    sliding: false,
    powerups: 0,
  };
  switch (entityId) {
    case "player_1": // runs forward, then turns
      return { ...base, x: 100 + 320 * s, z: 50, yaw: Math.PI / 2 + (s > 0.4 ? 0.8 : 0), vx: 320 };
    case "player_2": // strafes right, then left
      return s < 0.35
        ? { ...base, x: 300, z: 200 + 250 * s, yaw: -Math.PI / 2, vz: 250 }
        : { ...base, x: 300, z: 287.5 - 250 * (s - 0.35), yaw: -Math.PI / 2, vz: -250 };
    case "player_3": // crouch walks, slides, stands
      if (s < 0.2) return { ...base, x: -200 + 100 * s, z: 400, yaw: Math.PI / 2, vx: 100, crouching: true };
      if (s < 0.45)
        return {
          ...base,
          x: -180 + 380 * (s - 0.2),
          z: 400,
          yaw: Math.PI / 2,
          vx: 380,
          crouching: true,
          sliding: true,
        };
      return { ...base, x: -85, z: 400, yaw: Math.PI / 2 };
    case "player_4": {
      // jumps: up, peak, down
      const air = s > 0.15 && s < 0.5;
      const vy = air ? 270 - 800 * (s - 0.15) : 0;
      const y = air ? 24 + 270 * (s - 0.15) - 400 * (s - 0.15) ** 2 : 24;
      return { ...base, x: 600, y, z: -100, vy, grounded: !air };
    }
    case "player_5": // a teleporter halfway
      return { ...base, x: s < 0.3 ? -500 + 200 * s : 1800 + 200 * (s - 0.3), z: -400, yaw: Math.PI / 2, vx: 200 };
    case "player_6": // dies, then respawns elsewhere
      if (s >= 0.21 && s < 0.33) return null;
      return s < 0.21 ? { ...base, x: 900, z: 900, yaw: Math.PI } : { ...base, x: -900, z: -900, yaw: 0 };
    case "player_7": // quad carrier, changes team and weapon
      return {
        ...base,
        x: 50 + 150 * s,
        z: -700,
        yaw: Math.PI / 2,
        vx: 150,
        powerups: s > 0.14 && s < 0.4 ? QUAD : 0,
      };
    default: // player_8: the one we follow, walking
      return { ...base, x: 1200 + 150 * s, z: 1200, yaw: Math.PI / 2, vx: 150 };
  }
}

function teamOf(entityId: string, frame: number): string {
  if (entityId === "player_7") return frame < 45 ? "soba" : "udon";
  return Number(entityId.slice(-1)) % 2 ? "udon" : "soba";
}

function snapshot(tick: number, t: number, frame: number): GameState {
  const entities = new Map<string, unknown>();
  const players = new Map<string, unknown>();
  for (const entityId of PLAYERS) {
    players.set(entityId, { entityId, team: teamOf(entityId, frame) });
    const body = bodyAt(entityId, t);
    if (!body) continue;
    const components: Record<string, unknown> = {
      transform: { position: { x: body.x, y: body.y, z: body.z }, rotation: { y: body.yaw } },
      velocity: { linear: { x: body.vx, y: body.vy, z: body.vz }, grounded: body.grounded },
      movementState: { isCrouching: body.crouching, isSliding: body.sliding },
      powerups: { mask: body.powerups },
    };
    entities.set(entityId, { getComponent: (name: string) => components[name] });
  }
  players.set("player_99", { entityId: "player_99", team: "udon" });
  return { tick, entities, players } as unknown as GameState;
}

// ── What a frame looks like ─────────────────────────────────────────

const n = (v: number) => {
  const r = Number(v.toFixed(4));
  return Object.is(r, -0) ? 0 : r;
};
const v3 = (v: Vector3) => `${n(v.x)},${n(v.y)},${n(v.z)}`;
const on = (node: { isEnabled(checkAncestors?: boolean): boolean } | null | undefined) =>
  node ? (node.isEnabled(false) ? 1 : 0) : "-";

interface Hitbox {
  mesh: Mesh;
  model: PlayerModelInstance | null;
  weaponRoot: TransformNode | null;
  currentWeaponId: string;
  appliedVisualStyleKey: string | null;
}

function describePlayer(entityId: string, hitbox: Hitbox | undefined): string {
  if (!hitbox) return `${entityId} none`;
  const hb = hitbox.mesh;
  const parts = [`${entityId}`, `hb ${v3(hb.position)} ${n(hb.rotation.y)} ${n(hb.scaling.y)} ${on(hb)}`];
  const model = hitbox.model;
  if (!model) return [...parts, "model none"].join(" | ");
  parts.push(`anchor ${v3(model.anchor.position)} ${n(model.anchor.rotation.y)} ${on(model.anchor)}`);
  for (const mesh of [model.mesh, ...model.mesh.getChildMeshes()]) {
    if (mesh === hitbox.weaponRoot) continue;
    parts.push(
      `${mesh.name.split("/").pop()} ${on(mesh)}${mesh.isVisible ? 1 : 0}${n(mesh.visibility)}${mesh.alwaysSelectAsActiveMesh ? 1 : 0}`,
    );
  }
  parts.push(`weapon ${hitbox.currentWeaponId || "-"} ${on(hitbox.weaponRoot)}`);
  const group = model.masterGroup;
  parts.push(`anim ${model.currentAnim || "-"} ${group ? n(group.speedRatio) : "-"} ${group?.isPlaying ? 1 : 0}`);
  parts.push(`style ${hitbox.appliedVisualStyleKey ?? "-"}`);
  const body = model.mesh.getChildMeshes().find((m) => m.name.endsWith("/Body")) as Mesh;
  const material = body.material as PBRMaterial;
  parts.push(
    `look ${n(material.albedoColor.r)},${n(material.albedoColor.g)},${n(material.albedoColor.b)} ` +
      `${n(material.emissiveColor.r)},${n(material.emissiveColor.g)},${n(material.emissiveColor.b)} ` +
      `${body.renderOutline ? 1 : 0} ${n(body.outlineWidth)} ${n(body.outlineColor.r)},${n(body.outlineColor.g)},${n(body.outlineColor.b)}`,
  );
  const rootNode = model.mesh.getChildTransformNodes(true)[0];
  parts.push(`root ${v3(model.mesh.position)} ${v3(rootNode.position)} ${v3(model.hipsBind!.node.position)}`);
  return parts.join(" | ");
}

/** What animation would do between frames: drift the root and the hips. */
function driftRootMotion(hitboxes: Map<string, Hitbox>): void {
  for (const hitbox of hitboxes.values()) {
    const model = hitbox.model;
    if (!model) continue;
    model.mesh.position.set(1, 0, 2);
    model.mesh.getChildTransformNodes(true)[0].position.set(5, 0, 3);
    model.hipsBind!.node.position.addInPlaceFromFloats(2, 0.1, 1);
  }
}

/** Weapon models load asynchronously; wait until every requested one is on its hand. */
async function settle(hitboxes: Map<string, Hitbox>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if ([...hitboxes.values()].every((h) => !h.model || !h.currentWeaponId || h.weaponRoot)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("weapon models never finished loading");
}

async function record(): Promise<string[]> {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  world.scene = scene;
  const camera = new FreeCamera("eye", new Vector3(0, 60, 0), scene);
  scene.activeCamera = camera;

  let clock = 1000;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const quiet = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
  for (const spy of quiet) spy.mockImplementation(() => {});

  const cvars: Array<[string, unknown]> = [];
  const setCvar = (name: string, value: unknown) => {
    cvars.push([name, Cvar.get(name)]);
    Cvar.set(name, value as never);
  };

  const renderer = new RemotePlayerRenderer(scene);
  const internals = renderer as unknown as {
    modelManager: PlayerModelManager;
    hitboxes: Map<string, Hitbox>;
    playTeleportEffect(hitbox: unknown, entityId: string): void;
  };
  internals.modelManager = new StandInModelManager(scene);
  const teleports: string[] = [];
  internals.playTeleportEffect = (_hitbox, entityId) => teleports.push(entityId);
  const weapons = new Map<string, string>();
  renderer.setEnemyWeapons(weapons);
  // Vitest never settles two dynamic imports of a mocked module started in the
  // same frame (a browser does), so players draw their guns one frame apart.
  const armAt = (frame: number) => {
    const entityId = PLAYERS[frame];
    if (entityId && entityId !== "player_7") weapons.set(entityId, frame % 2 ? "plasmagun" : "machinegun");
  };

  const lines: string[] = [];
  try {
    let tick = 0;
    let nextSnapshot = clock;
    for (let frame = 0; frame < FRAMES; frame++) {
      const t = clock - 1000;
      // What the match does at this frame.
      armAt(frame);
      if (frame === 10) weapons.set("player_7", "rlauncher");
      if (frame === 30) renderer.markDead("player_6");
      if (frame === 15) renderer.setHiddenEntity("player_8");
      if (frame === 50) renderer.setHiddenEntity(null);
      if (frame === 55) weapons.set("player_7", "blade");
      if (frame === 25) setCvar("cl_player_outline", 0);
      if (frame === 60) setCvar("cl_player_outline", 1);
      if (frame === 62) setCvar("cl_remotehitbox", 1);
      if (frame === 68) setCvar("cl_remotehitbox", 0);
      if (frame === 70) setCvar("cl_player_fullbright", 1);
      if (frame === 80) setCvar("cl_player_fullbright", 0);
      // A wall: players 1 and 2 drop out of view for a while; player 5 after the teleporter.
      world.culled = (x) => (frame >= 40 && frame < 58 && x >= 100 && x <= 400) || (frame >= 75 && x > 1700);

      while (nextSnapshot <= clock) {
        renderer.pushSnapshot(snapshot(++tick, nextSnapshot - 1000, frame), "player_99");
        nextSnapshot += SNAPSHOT_MS;
      }

      driftRootMotion(internals.hitboxes);
      renderer.render();
      await settle(internals.hitboxes);

      lines.push(`# frame ${frame} t=${t}${teleports.length ? ` teleports ${teleports.join(",")}` : ""}`);
      teleports.length = 0;
      for (const entityId of PLAYERS) lines.push(describePlayer(entityId, internals.hitboxes.get(entityId)));
      clock += FRAME_MS;
    }
  } finally {
    renderer.dispose();
    for (const [name, value] of cvars.reverse()) Cvar.set(name, value as never);
    now.mockRestore();
    for (const spy of quiet) spy.mockRestore();
    scene.dispose();
    engine.dispose();
  }
  return lines;
}

describe("remote player rendering, frame by frame", () => {
  afterAll(() => vi.restoreAllMocks());

  it("matches the recording taken before the B12 optimisations", async () => {
    const lines = await record();
    if (process.env.UPDATE_RENDER_PARITY) {
      writeFileSync(FIXTURE, `${lines.join("\n")}\n`);
      return;
    }
    const expected = readFileSync(FIXTURE, "utf8").trimEnd().split("\n");
    // First difference, with its frame, rather than a 1,000-line diff.
    const first = lines.findIndex((line, i) => line !== expected[i]);
    if (first >= 0 || lines.length !== expected.length) {
      const at = first >= 0 ? first : Math.min(lines.length, expected.length);
      const frame = [...lines.slice(0, at + 1)].reverse().find((l) => l.startsWith("#"));
      expect({ frame, line: lines[at] }).toEqual({ frame, line: expected[at] });
    }
    expect(lines.length).toBe(expected.length);
  });

  it("covers what it claims to", async () => {
    const text = (await record()).join("\n");
    // The scenario is only a guard if these actually happen in it.
    for (const clip of ["run", "strafe_r", "strafe_l", "crouch_walk", "slide", "jump", "idle", "walk"]) {
      expect(text, clip).toContain(`anim ${clip} `);
    }
    expect(text).toContain("teleports player_5");
    expect(text).toMatch(/player_6 none/);
    expect(text).toMatch(/weapon rlauncher 1/);
    expect(text).toMatch(/weapon blade 1/);
    expect(text).toMatch(/player_1 \| hb [^|]+ 0 \| anchor [^|]+ 0/); // culled
    expect(text).toMatch(/player_8 \| hb [^|]+ 0 \| anchor [^|]+ 0/); // followed, hidden
    expect(text).toMatch(/anim \w+ [-\d.]+ 0 \|/); // a paused animation (culled or far)
    expect(text).toMatch(/look [^|]+ 1 [^|]+\| root/); // outline on
    expect(text).toMatch(/look [^|]+ 0 [^|]+\| root/); // outline off
    expect(text).toMatch(/player_7 \| hb [^|]+ 1 \|/); // cl_remotehitbox 1
  });
});
