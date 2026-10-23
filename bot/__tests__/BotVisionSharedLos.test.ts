import { expect, it, vi } from "vitest";
import type { BotGameState } from "../BotGameState";
import { BotVision, type MapKnowledgeData } from "../BotVision";

it("does not trace again for an enemy perception already checked this snapshot", () => {
  const world = { trace: vi.fn(() => ({ hit: false, fraction: 1 })) };
  const map = { spawnPoints: [], pickupPositions: [], triggerVolumes: [], mapFingerprint: "", mapName: "t" };
  const vision = new BotVision(world as never, map as MapKnowledgeData, false);
  const enemy = {
    playerId: "p2",
    entityId: "e2",
    relation: "enemy",
    isDead: false,
    position: { x: 300, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    health: 100,
  };
  const state = {
    tick: 10,
    self: { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 },
    players: [enemy],
    heardEnemies: [],
    pickups: [],
    lastKnownEnemyPositions: new Map(),
  } as unknown as BotGameState;

  const traceFrom = vi.spyOn(vision, "canSeeFrom");
  expect(vision.canSeeEnemy("e2", state.self.position, enemy.position, 10)).toBe(true);
  vision.getVisibleState(state);
  expect(traceFrom).toHaveBeenCalledTimes(1);

  // A new snapshot traces afresh for perception
  vision.canSeeEnemy("e2", state.self.position, enemy.position, 12);
  expect(traceFrom).toHaveBeenCalledTimes(2);
});
