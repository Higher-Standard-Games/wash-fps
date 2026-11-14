// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { HUDState } from "../HUDState";
import { FPSFragCounter } from "../hud/widgets/FragCounter";

const entry = (playerId: string, entityId: string, score: number) => ({
  playerId,
  entityId,
  name: playerId,
  score,
  deaths: 0,
  ping: 0,
});

describe("frag counter", () => {
  afterEach(() => HUDState.destroy());

  it("counts the followed player's frags in a demo, which has no local player", () => {
    const state = HUDState.getInstance();
    state.scoreboard = [entry("player_1", "e1", 4), entry("player_2", "e2", 9)];
    state.localPlayerId = "";
    state.spectating = "e2";
    const counter = new FPSFragCounter();
    counter.update(state);
    expect(counter.getElement().textContent).toBe("9FRAGS");
    state.spectating = "e1";
    counter.update(state);
    expect(counter.getElement().textContent).toBe("4FRAGS");
  });

  it("counts our own frags in play", () => {
    const state = HUDState.getInstance();
    state.scoreboard = [entry("player_1", "e1", 4), entry("player_2", "e2", 9)];
    state.localPlayerId = "player_1";
    state.spectating = "";
    const counter = new FPSFragCounter();
    counter.update(state);
    expect(counter.getElement().textContent).toBe("4FRAGS");
  });
});
