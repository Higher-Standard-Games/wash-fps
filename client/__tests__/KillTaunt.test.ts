import { describe, expect, it } from "vitest";
import { chooseKillTaunt, KILL_TAUNT_CHANCE } from "../KillTaunt";

const kill = (i: number) => ({ entityId: `e${i % 7}`, killerId: `k${i % 5}`, x: i * 13.7, y: 24, z: -i * 3.1 });

describe("chooseKillTaunt", () => {
  it("taunts after about three kills in ten, spread over all three taunts", () => {
    const counts = new Map<string, number>();
    const kills = 6000;
    for (let i = 0; i < kills; i++) {
      const taunt = chooseKillTaunt(kill(i));
      if (taunt) counts.set(taunt, (counts.get(taunt) ?? 0) + 1);
    }
    const taunted = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(taunted / kills).toBeGreaterThan(KILL_TAUNT_CHANCE - 0.03);
    expect(taunted / kills).toBeLessThan(KILL_TAUNT_CHANCE + 0.03);
    expect([...counts.keys()].sort()).toEqual(["taunt_1", "taunt_2", "taunt_3"]);
    for (const count of counts.values()) expect(count / taunted).toBeGreaterThan(0.25);
  });

  it("gives every viewer the same answer for the same kill", () => {
    for (let i = 0; i < 50; i++) expect(chooseKillTaunt({ ...kill(i) })).toBe(chooseKillTaunt(kill(i)));
  });

  it("never taunts for a suicide or a death with no killer", () => {
    for (let i = 0; i < 200; i++) {
      expect(chooseKillTaunt({ ...kill(i), killerId: `e${i % 7}` })).toBeNull();
      expect(chooseKillTaunt({ ...kill(i), killerId: "" })).toBeNull();
    }
  });
});
