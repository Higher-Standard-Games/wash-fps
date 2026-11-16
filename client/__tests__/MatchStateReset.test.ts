import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../engine/physics/CollisionManager", () => ({
  getCollisionManager: () => ({ getSweepBackend: () => null }),
}));

import { MatchPhase, MatchStateManager } from "../MatchStateManager";

/** Every field but the phase listeners, which outlive a reset by design. */
function fields(manager: MatchStateManager): Record<string, unknown> {
  const { _phaseCallbacks: _, ...rest } = manager as unknown as Record<string, unknown>;
  return JSON.parse(JSON.stringify(rest));
}

describe("MatchStateManager.reset", () => {
  it("leaves nothing of the last match, as a fresh manager has nothing", () => {
    MatchStateManager.destroy();
    const manager = MatchStateManager.getInstance();
    const fresh = fields(manager);
    manager.setCampaignCountdown(true);
    manager.processEvent({
      type: "match_state",
      phase: MatchPhase.Active,
      timeRemaining: 90,
      timeElapsed: 30,
      readyCount: 2,
      totalPlayers: 2,
      gametypeName: "S&D",
      teamBased: true,
      scoreLimit: 7,
      teamScores: { udon: 3, soba: 2 },
      playerTeams: { player_1: "udon" },
      teamNames: { udon: "Udon" },
      winner: "udon",
      overtime: 1,
      flow: "single",
      round: 6,
      teamRoles: { udon: "attack" },
      roundState: "live",
    } as never);
    expect(fields(manager)).not.toEqual(fresh);
    manager.reset();
    expect(fields(manager)).toEqual(fresh);
    MatchStateManager.destroy();
  });
});
