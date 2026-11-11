import { describe, expect, it } from "vitest";
import type { TriggerVolume } from "../../../../shared/bsp/TriggerTable";
import { teleportExitYaw } from "../TeleportExit";

const TELE: TriggerVolume = {
  id: 0,
  type: "teleport",
  min: { x: -16, y: 0, z: -16 },
  max: { x: 16, y: 64, z: 16 },
  dest: { x: 1000, y: 0, z: 500 },
  destYaw: Math.PI,
};
const PAD: TriggerVolume = { ...TELE, id: 1, type: "push", dest: { x: 1000, y: 0, z: 520 }, destYaw: undefined };

describe("teleportExitYaw", () => {
  it("gives the exit yaw when the bot jumps to a teleporter's exit", () => {
    expect(teleportExitYaw({ x: 0, y: 24, z: 0 }, { x: 1010, y: 25, z: 470 }, [TELE])).toBe(Math.PI);
  });

  it("ignores ordinary movement near an exit", () => {
    expect(teleportExitYaw({ x: 1000, y: 25, z: 560 }, { x: 1000, y: 25, z: 500 }, [TELE])).toBeNull();
  });

  it("ignores a jump that does not land at a teleporter exit", () => {
    expect(teleportExitYaw({ x: 0, y: 24, z: 0 }, { x: 1000, y: 25, z: 520 }, [PAD])).toBeNull();
    expect(teleportExitYaw({ x: 0, y: 24, z: 0 }, { x: 3000, y: 25, z: 0 }, [TELE])).toBeNull();
  });

  it("treats a missing exit angle as 0, as the movement code does", () => {
    const noYaw = { ...TELE, destYaw: undefined };
    expect(teleportExitYaw({ x: 0, y: 24, z: 0 }, { x: 1000, y: 25, z: 500 }, [noYaw])).toBe(0);
  });
});
