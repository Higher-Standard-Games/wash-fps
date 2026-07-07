import { playerId } from "@engine/server/ecs/types";
import { describe, expect, it, vi } from "vitest";
import { MovementValidator } from "../MovementValidator";

describe("MovementValidator", () => {
  it("rate cap still drops excess inputs in one server tick", () => {
    const v = new MovementValidator(144, 125);
    const p = playerId(1);
    v.addClient(p);

    const results = Array.from({ length: 8 }, () => v.validateInput(p));

    expect(results.filter(Boolean)).toHaveLength(4);
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
});
