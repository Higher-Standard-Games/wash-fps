import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState } from "../../../../engine/network/core/GameState";
import { BinaryProtocol } from "../../../../engine/network/protocol/BinaryProtocol";
import { BrushModelState } from "../../../../shared/bsp/BrushModelState";

const context = vi.hoisted(() => ({ state: undefined as BrushModelState | undefined }));
vi.mock("../../../../engine/physics/CollisionManager", () => ({
  getCollisionManager: () => ({ getSweepBackend: () => ({ brushModels: context.state }) }),
}));

import { MatchStateManager } from "../MatchStateManager";

function event(disabledModels?: number[]) {
  return { type: "match_state", round: 1, objective: { kind: "bomb", phase: "detonated", disabledModels } };
}

describe("bomb brush snapshots", () => {
  afterEach(() => {
    MatchStateManager.destroy();
    context.state = undefined;
  });

  it("round trips persistent geometry state through the wire and restores for a late join", () => {
    context.state = new BrushModelState([
      {
        modelIndex: 5,
        targetname: "a",
        delay: 0.6,
        initiallyEnabled: true,
        origin: { x: 0, y: 0, z: 0 },
        min: { x: 0, y: 0, z: 0 },
        max: { x: 1, y: 1, z: 1 },
        debris: [],
      },
    ]);
    const sent = new GameState();
    sent.events.push(event([5]) as never);
    const received = BinaryProtocol.decodeSnapshot(BinaryProtocol.encodeSnapshot(sent));
    MatchStateManager.getInstance().processEvent(received.events[0]);
    expect(context.state.isEnabled(5)).toBe(false);
    // A round reset restores collision; a demo recorded without this field is readable.
    MatchStateManager.getInstance().processEvent(event());
    expect(context.state.isEnabled(5)).toBe(true);
  });

  it("reads an older event with the extension absent", () => {
    const sent = new GameState();
    sent.events.push(event() as never);
    const received = BinaryProtocol.decodeSnapshot(BinaryProtocol.encodeSnapshot(sent));
    expect(
      (received.events[0] as unknown as { objective: { disabledModels?: number[] } }).objective.disabledModels,
    ).toBeUndefined();
  });
});
