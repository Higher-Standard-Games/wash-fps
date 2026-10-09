// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { HUDState } from "../HUDState";

/**
 * The air meter is about our lungs, so it follows our death, not the watched
 * player's. Dead underwater and watching a living teammate, the meter came back
 * reading DROWNING from the mirror of our own air (L4).
 */
vi.mock("../../Game", () => ({
  Game: { getInstance: () => ({ localAirFraction: 0, localDrowning: true }) },
}));

const { FPSAirMeter } = await import("../hud/widgets/AirMeter");

describe("air meter", () => {
  it("stays down while we are dead, whoever the camera follows", () => {
    const meter = new FPSAirMeter();
    meter.update({ localDead: true, dead: false } as HUDState);
    expect(meter.getElement().style.display).toBe("none");

    meter.update({ localDead: false, dead: false } as HUDState);
    expect(meter.getElement().style.display).toBe("");
    meter.destroy();
  });
});
