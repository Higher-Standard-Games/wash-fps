/**
 * Watching someone means seeing what they saw. In a demo the player followed
 * wears your own side's colour and everyone else is read from their side, as in
 * live play; without a perspective, everyone wears the free-for-all colour. And
 * while you are behind their eyes, their beam leaves the gun on screen, not the
 * hidden body below the camera.
 */

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../engine/loader/bsp/BspManager", () => ({
  BspManager: { getInstance: () => ({ getPvsCuller: () => null }) },
}));

const { RemotePlayerRenderer } = await import("../RemotePlayerRenderer");

interface Internals {
  teams: Map<string, string>;
  resolvePlayerTeamSlot(entityId: string): string;
}

let scene: Scene;

function renderer(teams: Record<string, string>) {
  scene = new Scene(new NullEngine());
  const r = new RemotePlayerRenderer(scene);
  const internals = r as unknown as Internals;
  for (const [id, team] of Object.entries(teams)) internals.teams.set(id, team);
  return { r, slot: (id: string) => internals.resolvePlayerTeamSlot(id) };
}

afterEach(() => scene?.getEngine().dispose());

describe("demo perspective colours", () => {
  it("colours the followed duellist as you and the opponent as anyone you can shoot", () => {
    const { r, slot } = renderer({ player_1: "ffa", player_2: "ffa" });
    expect([slot("player_1"), slot("player_2")]).toEqual(["ffa", "ffa"]);
    r.setPerspectiveEntity("player_1");
    expect([slot("player_1"), slot("player_2")]).toEqual(["ally", "ffa"]);
    r.setPerspectiveEntity("player_2");
    expect([slot("player_1"), slot("player_2")]).toEqual(["ffa", "ally"]);
  });

  it("reads teammates and opponents from the followed player's side", () => {
    const { r, slot } = renderer({ a: "soba", b: "soba", c: "udon" });
    r.setPerspectiveEntity("a");
    expect([slot("a"), slot("b"), slot("c")]).toEqual(["ally", "ally", "enemy"]);
    r.setPerspectiveEntity(null);
    expect([slot("a"), slot("b"), slot("c")]).toEqual(["ffa", "ffa", "ffa"]);
  });
});

describe("the followed player's beam", () => {
  it("leaves the gun on screen while they are watched through their eyes", () => {
    const { r } = renderer({ a: "ffa" });
    const internals = r as unknown as { hitboxes: Map<string, unknown> };
    internals.hitboxes.set("a", {
      mesh: { setEnabled: () => {} },
      smoothedPos: new Vector3(0, 0, 0),
      weaponMuzzle: null,
      weaponRoot: null,
    });
    const onScreen = new Vector3(5, 50, 7);
    r.setFollowedMuzzle(() => onScreen);
    const start = new Vector3();

    // Seen from outside: their body's gun (here, the body fallback)
    r.getWeaponMuzzleWorldPositionToRef("a", new Vector3(0, 0, 1), start);
    expect(start.y).toBe(20);

    // Behind their eyes: the barrel on screen
    r.setHiddenEntity("a");
    r.getWeaponMuzzleWorldPositionToRef("a", new Vector3(0, 0, 1), start);
    expect(start.asArray()).toEqual([5, 50, 7]);

    // With no gun on screen (a reel's fly-by), back to the body
    r.setFollowedMuzzle(() => null);
    r.getWeaponMuzzleWorldPositionToRef("a", new Vector3(0, 0, 1), start);
    expect(start.y).toBe(20);
  });
});
