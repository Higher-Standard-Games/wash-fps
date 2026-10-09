import { afterEach, describe, expect, it } from "vitest";
import { Amphi } from "../../server/gametypes/Amphi";
import { Deathmatch } from "../../server/gametypes/Deathmatch";
import { Duel } from "../../server/gametypes/Duel";
import { MatchState } from "../../server/gametypes/MatchState";
import { SearchAndDestroy } from "../../server/gametypes/SearchAndDestroy";
import { TeamDeathmatch } from "../../server/gametypes/TeamDeathmatch";
import { MatchStateManager } from "../MatchStateManager";

afterEach(() => MatchStateManager.destroy());

/**
 * Which modes ask for a kit, and when a change applies: the server says so in
 * `match_state`, so the client never guesses from the mode's name.
 */
describe("kit modes, as the client hears them", () => {
  it("asks for a kit in S&D, Amphi and Deathmatch, while Duel and TDM join directly", () => {
    const match = MatchStateManager.getInstance();
    for (const [mode, timing] of [
      [new SearchAndDestroy(), "round"],
      [new Amphi(), "round"],
      [new Deathmatch(), "respawn"],
      [new Duel(), null],
      [new TeamDeathmatch(), null],
    ] as const) {
      const server = new MatchState(mode.name, mode.getMatchConfig(), mode.teamBased);
      match.processEvent({ type: "match_state", ...server.toSnapshot() });
      expect(match.loadoutMode, mode.name).toBe(timing);
      expect(match.requiresLoadoutSelection, mode.name).toBe(timing !== null);
    }
  });
});
