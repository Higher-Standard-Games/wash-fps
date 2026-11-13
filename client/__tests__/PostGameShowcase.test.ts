import { describe, expect, it } from "vitest";
import { pickVictoryClip } from "../PostGameShowcase";

describe("pickVictoryClip", () => {
  const all = ["idle", "dance_1", "dance_2", "dance_3", "taunt_1", "taunt_2", "taunt_3"];

  it("picks each of the six dances and taunts with equal odds", () => {
    const picks = [0, 1, 2, 3, 4, 5].map((i) => pickVictoryClip(all, () => (i + 0.5) / 6));
    expect(picks).toEqual(["dance_1", "dance_2", "dance_3", "taunt_1", "taunt_2", "taunt_3"]);
  });

  it("chooses only among clips that loaded", () => {
    expect(pickVictoryClip(["idle", "taunt_2"], () => 0)).toBe("taunt_2");
    expect(pickVictoryClip(["idle", "run"])).toBeNull();
  });
});
