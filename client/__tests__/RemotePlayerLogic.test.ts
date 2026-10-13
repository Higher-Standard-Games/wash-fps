import { describe, expect, it } from "vitest";
import type { InterpolatedEntity } from "../../../../engine/network/client/SnapshotBuffer";
import { Entity } from "../../../../engine/network/core/Entity";
import { GameState } from "../../../../engine/network/core/GameState";
import {
  animationLodRadiusSq,
  applyRoster,
  deriveAnimation,
  extractEntities,
  IDLE_SPEED_THRESHOLD,
  legacyTeamColor,
  RUN_SPEED_THRESHOLD,
  SWIM_IDLE_SPEED_THRESHOLD,
  sphereInFrustum,
} from "../RemotePlayerLogic";

const component = <T extends object>(data: T) => ({
  ...data,
  serialize: () => ({}),
  deserialize: () => {},
  clone() {
    return this;
  },
});

function entity(id: string, components: Record<string, object>): Entity {
  const e = new Entity(id);
  for (const [name, data] of Object.entries(components)) e.addComponent(name, component(data) as never);
  return e;
}

function state(...entities: Entity[]): GameState {
  const s = new GameState();
  for (const e of entities) s.entities.set(e.id, e);
  return s;
}

/** Facing +Z (yaw 0): forward is +Z, the model's right is +X. */
const at = (over: Partial<InterpolatedEntity>): InterpolatedEntity =>
  ({
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: true,
    crouching: false,
    sliding: false,
    wallJumping: false,
    ...over,
  }) as InterpolatedEntity;

describe("extractEntities", () => {
  it("takes remote players only: not the local player, projectiles, items, or entities without a position", () => {
    const s = state(
      entity("player_1", { transform: { position: { x: 1, y: 2, z: 3 }, rotation: { y: 0.5 } } }),
      entity("player_2", { transform: { position: { x: 0, y: 0, z: 0 } } }),
      entity("player_3", { velocity: { x: 1 } }),
      entity("proj_9", { transform: { position: { x: 0, y: 0, z: 0 } } }),
      entity("item_50001", { transform: { position: { x: 0, y: 0, z: 0 } } }),
    );
    const out = extractEntities(s, "player_2");
    expect([...out.keys()]).toEqual(["player_1"]);
  });

  it("reads the movement components, preferring linear velocity", () => {
    const s = state(
      entity("player_1", {
        transform: { position: { x: 1, y: 2, z: 3 }, rotation: { x: -0.25, y: 0.5 } },
        velocity: { x: 9, y: 9, z: 9, linear: { x: 4, y: 5, z: 6 }, grounded: false },
        movementState: {
          isCrouching: true,
          isSliding: true,
          wallJumpState: "charging",
          crouchViewOffset: -12,
          waterLevel: 2,
          onLadder: true,
        },
        powerups: { mask: 1 },
      }),
    );
    expect(extractEntities(s, "player_9").get("player_1")).toEqual({
      x: 1,
      y: 2,
      z: 3,
      yaw: 0.5,
      pitch: -0.25,
      vx: 4,
      vy: 5,
      vz: 6,
      grounded: false,
      crouching: true,
      sliding: true,
      wallJumping: true,
      crouchViewOffset: -12,
      powerupMask: 1,
      waterLevel: 2,
      onLadder: true,
    });
  });

  it("defaults a bare entity to standing still on the ground", () => {
    const s = state(
      entity("player_1", { transform: { position: { x: 0, y: 0, z: 0 } }, velocity: { x: 3, y: 0, z: 4 } }),
    );
    expect(extractEntities(s, "")).toEqual(
      new Map([
        [
          "player_1",
          {
            x: 0,
            y: 0,
            z: 0,
            yaw: 0,
            pitch: 0,
            vx: 3,
            vy: 0,
            vz: 4,
            grounded: true,
            crouching: false,
            sliding: false,
            wallJumping: false,
            crouchViewOffset: 0,
            powerupMask: 0,
            waterLevel: 0,
            onLadder: false,
          },
        ],
      ]),
    );
  });
});

describe("applyRoster", () => {
  it("records every player's team, with no team as ffa", () => {
    const teams = new Map<string, string>();
    applyRoster(
      teams,
      [
        { entityId: "player_1", team: "udon" },
        { entityId: "player_2", team: "" },
      ],
      "player_9",
    );
    expect(teams).toEqual(
      new Map([
        ["player_1", "udon"],
        ["player_2", "ffa"],
      ]),
    );
  });

  it("returns the local player's team, null when it has none, undefined when absent", () => {
    const players = [
      { entityId: "player_1", team: "soba" },
      { entityId: "player_2", team: undefined },
    ];
    expect(applyRoster(new Map(), players, "player_1")).toBe("soba");
    expect(applyRoster(new Map(), players, "player_2")).toBeNull();
    expect(applyRoster(new Map(), players, "player_3")).toBeUndefined();
  });
});

describe("legacyTeamColor", () => {
  it("maps ally to alpha and enemy to bravo", () => {
    expect(legacyTeamColor("ally", "player_1")).toBe("alpha");
    expect(legacyTeamColor("enemy", "player_1")).toBe("bravo");
  });

  it("without sides, picks a stable colour from the id", () => {
    const first = legacyTeamColor("ffa", "player_1");
    expect(legacyTeamColor("ffa", "player_1")).toBe(first);
    // "player_1" and "player_2" differ by one character code, so they land on different colours
    expect(legacyTeamColor("ffa", "player_2")).not.toBe(first);
  });
});

describe("animationLodRadiusSq", () => {
  it("is the squared distance where the body covers minPixels of screen", () => {
    // fov 90°: tan(45°) = 1, so radius = 64 * 1000 / (2 * 1 * 24)
    const r = (64 * 1000) / 48;
    expect(animationLodRadiusSq(Math.PI / 2, 0, 1000, 64, 24)).toBeCloseTo(r * r, 6);
  });

  it("is 0, meaning pause nothing, when the camera cannot be measured", () => {
    expect(animationLodRadiusSq(undefined, 0, 1000, 64, 24)).toBe(0);
    expect(animationLodRadiusSq(0, 0, 1000, 64, 24)).toBe(0);
    expect(animationLodRadiusSq(Number.NaN, 0, 1000, 64, 24)).toBe(0);
    expect(animationLodRadiusSq(1, 1, 1000, 64, 24)).toBe(0); // orthographic
    expect(animationLodRadiusSq(1, 0, 0, 64, 24)).toBe(0);
  });

  it("treats a camera with no mode as perspective", () => {
    expect(animationLodRadiusSq(1, undefined, 1000, 64, 24)).toBeGreaterThan(0);
  });
});

describe("deriveAnimation", () => {
  const run = RUN_SPEED_THRESHOLD + 1;
  const walk = IDLE_SPEED_THRESHOLD + 1;

  it.each([
    ["walljump", at({ wallJumping: true, grounded: false, waterLevel: 3 })],
    ["swim", at({ waterLevel: 2, grounded: false, vy: -(SWIM_IDLE_SPEED_THRESHOLD + 1) })],
    ["swim_idle", at({ waterLevel: 2, grounded: false, vy: -60 })],
    ["climb", at({ onLadder: true, grounded: false })],
    ["jump", at({ grounded: false, vz: run })],
    ["slide", at({ sliding: true, crouching: true, vz: run })],
    ["crouch_walk", at({ crouching: true })],
    ["crouch_walk", at({ crouching: true, vz: walk })],
    ["crouch_strafe_l", at({ crouching: true, vx: walk })],
    ["crouch_strafe_r", at({ crouching: true, vx: -walk })],
    ["idle", at({})],
    ["walk", at({ vz: walk })],
    ["walk", at({ vz: -walk })],
    ["run", at({ vz: run })],
    ["strafe_l", at({ vx: run })],
    ["strafe_r", at({ vx: -run })],
  ])("%s", (expected, interp) => {
    expect(deriveAnimation(interp)).toBe(expected);
  });

  it("strafes only when sideways speed is over 1.5 times forward speed", () => {
    expect(deriveAnimation(at({ vx: 150, vz: 100 }))).toBe("walk");
    expect(deriveAnimation(at({ vx: 151, vz: 100 }))).toBe("strafe_l");
  });

  it("follows yaw: facing +X, moving along +X is forward", () => {
    expect(deriveAnimation(at({ yaw: Math.PI / 2, vx: run }))).toBe("run");
  });
});

describe("sphereInFrustum", () => {
  // A unit cube "frustum": inside when -1 <= x,y,z <= 1.
  const planes = [
    { normal: { x: 1, y: 0, z: 0 }, d: 1 },
    { normal: { x: -1, y: 0, z: 0 }, d: 1 },
    { normal: { x: 0, y: 1, z: 0 }, d: 1 },
    { normal: { x: 0, y: -1, z: 0 }, d: 1 },
    { normal: { x: 0, y: 0, z: 1 }, d: 1 },
    { normal: { x: 0, y: 0, z: -1 }, d: 1 },
  ];

  it("keeps spheres inside or overlapping a plane", () => {
    expect(sphereInFrustum(planes, 0, 0, 0, 0.1)).toBe(true);
    expect(sphereInFrustum(planes, 1.5, 0, 0, 0.6)).toBe(true);
  });

  it("rejects a sphere wholly behind any one plane", () => {
    expect(sphereInFrustum(planes, 1.5, 0, 0, 0.4)).toBe(false);
    expect(sphereInFrustum(planes, 0, 0, -3, 1)).toBe(false);
  });
});
