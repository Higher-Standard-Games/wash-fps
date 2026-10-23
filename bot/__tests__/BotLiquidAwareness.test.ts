/**
 * Bots and liquid contents (water Phase 0).
 *
 * `isInsideSolid` used to be `pointContents(point) !== 0`, which was safe only
 * because contents could never report anything but solidity. Making the query
 * liquid-aware turns that predicate into "is there anything here at all" — and
 * a bot that reads water as solid discards every nav node in a pool and
 * rejects every edge crossing one. Sixteen of the thirty-nine shipped maps
 * contain liquid, including five of the six bomb maps, so that is not a corner
 * case.
 */

import { describe, expect, it } from "vitest";
import { type CollisionWorld, Contents } from "../../../../shared/collision/CollisionWorld";
import { BotVision, type MapKnowledgeData } from "../BotVision";

const mapKnowledge: MapKnowledgeData = {
  mapName: "test",
  mapFingerprint: "test-fingerprint",
  spawnPoints: [],
  pickups: [],
  triggers: [],
} as unknown as MapKnowledgeData;

function visionReporting(contents: number): BotVision {
  const collision = {
    trace: () => ({ hit: false, fraction: 1 }),
    pointContents: () => contents,
  } as unknown as CollisionWorld;
  return new BotVision(collision, mapKnowledge, false);
}

describe("BotVision.isInsideSolid", () => {
  it("still reports solid geometry", () => {
    expect(visionReporting(Contents.SOLID).isInsideSolid({ x: 0, y: 0, z: 0 })).toBe(true);
  });

  it("counts playerclip as solid, because it stops a body", () => {
    expect(visionReporting(Contents.PLAYERCLIP).isInsideSolid({ x: 0, y: 0, z: 0 })).toBe(true);
  });

  it("does not call water solid", () => {
    expect(visionReporting(Contents.WATER).isInsideSolid({ x: 0, y: 0, z: 0 })).toBe(false);
  });

  it("does not call slime or lava solid either", () => {
    // They hurt, which is a gameplay rule for later. They do not block, which
    // is the only question this predicate asks.
    expect(visionReporting(Contents.SLIME).isInsideSolid({ x: 0, y: 0, z: 0 })).toBe(false);
    expect(visionReporting(Contents.LAVA).isInsideSolid({ x: 0, y: 0, z: 0 })).toBe(false);
  });

  it("does not call a trigger volume solid", () => {
    // Jumppads and teleporters are trigger brushes sitting exactly where bots
    // most need nav nodes.
    expect(visionReporting(Contents.TRIGGER).isInsideSolid({ x: 0, y: 0, z: 0 })).toBe(false);
  });

  it("reports solid when a volume is both water and solid", () => {
    const contents = Contents.WATER | Contents.SOLID;

    expect(visionReporting(contents).isInsideSolid({ x: 0, y: 0, z: 0 })).toBe(true);
  });

  it("reports empty space as clear", () => {
    expect(visionReporting(Contents.EMPTY).isInsideSolid({ x: 0, y: 0, z: 0 })).toBe(false);
  });
});
