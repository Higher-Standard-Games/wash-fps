import { describe, expect, it } from "vitest";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../../engine/network/components/TransformComponent";
import type { StoredInput } from "../InputHistory";
import { V2NetworkClient } from "../V2NetworkClient";

function storedInputs(client: V2NetworkClient): StoredInput[] {
  return (
    client as unknown as {
      inputHistory: { getUnacked(ackedSeq: number): StoredInput[] };
    }
  ).inputHistory.getUnacked(0);
}

describe("V2NetworkClient input sanitization parity", () => {
  it("stores and predicts with the same sanitized command shape the server applies", () => {
    const client = new V2NetworkClient({ tickRate: 125 });
    const seq = client.processInput({
      direction: { x: 1000, y: 99, z: 0 },
      pitch: Math.PI,
      yaw: 3 * Math.PI,
      buttons: InputButtons.FORWARD,
      clientTick: 10,
    });

    expect(seq).toBe(1);
    const [stored] = storedInputs(client);
    expect(stored.direction).toEqual({ x: 1, y: 0, z: 0 });
    expect(stored.pitch).toBeCloseTo(Math.PI / 2, 6);
    expect(stored.yaw).toBeCloseTo(Math.PI, 6);
    expect(stored.buttons).toBe(InputButtons.FORWARD);
  });

  it("neutralizes non-finite local input instead of predicting NaN state", () => {
    const client = new V2NetworkClient({ tickRate: 125 });
    client.processInput({
      direction: { x: Number.NaN, y: 0, z: 0 } as Vec3,
      pitch: 0,
      yaw: 0,
      buttons: InputButtons.FORWARD,
      clientTick: 10,
    });

    const [stored] = storedInputs(client);
    expect(stored.direction).toEqual({ x: 0, y: 0, z: 0 });
    expect(stored.buttons).toBe(0);
    const pos = client.getPosition();
    expect(Number.isFinite(pos.x)).toBe(true);
    expect(Number.isFinite(pos.y)).toBe(true);
    expect(Number.isFinite(pos.z)).toBe(true);
  });
});
