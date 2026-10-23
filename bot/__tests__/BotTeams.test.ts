import { describe, expect, it } from "vitest";
import { onATeam } from "../BotGameState";

describe("a bot's idea of a team", () => {
  it("reads udon and soba as teams, and FFA players (old or new) as on none", () => {
    expect(onATeam("udon")).toBe(true);
    expect(onATeam("soba")).toBe(true);
    expect(onATeam("ffa")).toBe(false);
    expect(onATeam("spectator")).toBe(false);
    expect(onATeam("")).toBe(false);
    expect(onATeam(undefined)).toBe(false);
  });
});
