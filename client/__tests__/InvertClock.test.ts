import { afterEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { MatchPhase } from "../../../../shared/server/gametype/GametypeTypes";
import { MatchStateManager } from "../MatchStateManager";

describe("cl_invertClock", () => {
  afterEach(() => Cvar.set("cl_invertClock", 0));

  it("shows time left by default and time played when set", () => {
    const match = MatchStateManager.getInstance();
    match.processEvent({ type: "match_state", phase: MatchPhase.Active, timeRemaining: 535, timeElapsed: 65 });
    expect(match.getTimeString()).toBe("8:55");
    Cvar.set("cl_invertClock", 1);
    expect(match.getTimeString()).toBe("1:05");
  });

  it("keeps the countdown for a server that does not send time played", () => {
    const match = MatchStateManager.getInstance();
    Cvar.set("cl_invertClock", 1);
    match.processEvent({ type: "match_state", phase: MatchPhase.Active, timeRemaining: 535 });
    expect(match.getTimeString()).toBe("8:55");
  });
});
