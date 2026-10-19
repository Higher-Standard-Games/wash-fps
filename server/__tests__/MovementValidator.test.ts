import { playerId } from "@engine/server/ecs/types";
import { describe, expect, it, vi } from "vitest";
import { MAX_BURST_INPUTS, MovementValidator } from "../MovementValidator";

describe("MovementValidator", () => {
  it("flood guard still drops excess inputs in one server tick", () => {
    const v = new MovementValidator(144, 125);
    const p = playerId(1);
    v.addClient(p);

    const results = Array.from({ length: MAX_BURST_INPUTS + 8 }, () => v.validateInput(p));

    expect(results.filter(Boolean)).toHaveLength(MAX_BURST_INPUTS);
  });

  it("accepts a low frame-rate client's whole burst in one tick", () => {
    // 20 FPS sends 6-7 commands per frame, and a stalled link delivers more.
    const v = new MovementValidator(144, 125);
    const p = playerId(1);
    v.addClient(p);
    for (let i = 0; i < 30; i++) expect(v.validateInput(p)).toBe(true);
  });

  it("budget overshoot records strikes but no longer drops", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = new MovementValidator(144, 125);
    const p = playerId(1);
    v.addClient(p);

    let accepted = 0;
    for (let i = 0; i < 200; i++) {
      v.onTick();
      if (v.validateInput(p)) accepted++;
    }

    expect(accepted).toBe(200);
    expect(v.getStrikes(p)).toBeGreaterThan(0);
    now.mockRestore();
    warn.mockRestore();
  });

  describe("time budget", () => {
    function at(ms: number) {
      return vi.spyOn(performance, "now").mockReturnValue(ms);
    }

    it("earns credit back as real time passes", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const now = at(1000);
      const v = new MovementValidator(100, 125); // 10 ms an input
      const p = playerId(1);
      v.addClient(p);
      // Spend the 500 ms starting budget in one instant.
      for (let i = 0; i < 50; i++) {
        v.onTick();
        v.validateInput(p);
      }
      expect(v.getStrikes(p)).toBe(0);
      v.onTick();
      v.validateInput(p);
      expect(v.getStrikes(p)).toBe(1);

      // 30 ms later there is credit for three more, and not a fourth.
      now.mockReturnValue(1030);
      for (let i = 0; i < 3; i++) {
        v.onTick();
        v.validateInput(p);
      }
      expect(v.getStrikes(p)).toBe(1);
      v.onTick();
      v.validateInput(p);
      expect(v.getStrikes(p)).toBe(2);
      now.mockRestore();
      warn.mockRestore();
    });

    it("banks at most 500 ms, however long the client sat idle", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const now = at(0);
      const v = new MovementValidator(100, 125);
      const p = playerId(1);
      v.addClient(p);
      now.mockReturnValue(60_000);
      for (let i = 0; i < 50; i++) {
        v.onTick();
        v.validateInput(p);
      }
      expect(v.getStrikes(p)).toBe(0);
      v.onTick();
      v.validateInput(p);
      expect(v.getStrikes(p)).toBe(1);
      now.mockRestore();
      warn.mockRestore();
    });
  });

  it("lets the flood guard through again on the next tick", () => {
    const v = new MovementValidator(144, 125);
    const p = playerId(1);
    v.addClient(p);
    for (let i = 0; i < MAX_BURST_INPUTS; i++) expect(v.validateInput(p)).toBe(true);
    expect(v.validateInput(p)).toBe(false);
    v.onTick();
    expect(v.validateInput(p)).toBe(true);
  });

  it("lets an unknown client through rather than locking it out", () => {
    const v = new MovementValidator();
    for (let i = 0; i < 20; i++) expect(v.validateInput(playerId(9))).toBe(true);
    expect(v.getStrikes(playerId(9))).toBe(0);
  });

  it("keeps a player's strikes across spectating and rejoining, and forgets them when they leave", () => {
    const v = new MovementValidator(144, 125);
    const p = playerId(1);
    v.addClient(p);
    for (let i = 0; i < MAX_BURST_INPUTS + 2; i++) v.validateInput(p); // two over the cap
    expect(v.getStrikes(p)).toBe(2);

    v.removeClient(p); // spectate, or a held seat
    expect(v.getStrikes(p)).toBe(2);
    v.addClient(p); // rejoin, or resume
    expect(v.getStrikes(p)).toBe(2);
    expect(v.getStats(p)).toMatchObject({ rejected: 2, accepted: MAX_BURST_INPUTS });

    v.forgetClient(p);
    v.addClient(p);
    expect(v.getStrikes(p)).toBe(0);
  });
});
