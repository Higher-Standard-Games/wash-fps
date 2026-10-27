// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HUDState } from "../HUDState";

/**
 * The air meter is about our lungs, so it follows our death, not the watched
 * player's. Dead underwater and watching a living teammate, the meter came back
 * reading DROWNING from the mirror of our own air (L4).
 */
const localAir = vi.hoisted(() => ({ localAirFraction: 0, localDrowning: true }));
vi.mock("../../Game", () => ({ Game: { getInstance: () => localAir } }));

const { FPSAirMeter } = await import("../hud/widgets/AirMeter");

describe("air meter", () => {
  beforeEach(() => {
    Object.assign(localAir, { localAirFraction: 0, localDrowning: true });
  });

  it("stays down while we are dead, whoever the camera follows", () => {
    const meter = new FPSAirMeter();
    meter.update({ localDead: true, dead: false } as HUDState);
    expect(meter.getElement().style.display).toBe("none");

    meter.update({ localDead: false, dead: false } as HUDState);
    expect(meter.getElement().style.display).toBe("");
    meter.destroy();
  });

  it("enters drowning even when the displayed fill step is already zero", () => {
    const meter = new FPSAirMeter();
    const state = { localDead: false } as HUDState;
    Object.assign(localAir, { localAirFraction: 0.02, localDrowning: false });
    meter.update(state);
    expect(meter.getElement().textContent).toBe("AIR");

    Object.assign(localAir, { localAirFraction: 0, localDrowning: true });
    meter.update(state);
    expect(meter.getElement().textContent).toBe("DROWNING");
    expect(meter.getElement().classList.contains("fps-air-meter--drowning")).toBe(true);

    Object.assign(localAir, { localAirFraction: 0.02, localDrowning: false });
    meter.update(state);
    expect(meter.getElement().textContent).toBe("AIR");
    expect(meter.getElement().classList.contains("fps-air-meter--drowning")).toBe(false);
    meter.destroy();
  });

  it("updates the low-air warning independently of the quantized fill", () => {
    const meter = new FPSAirMeter();
    const state = { localDead: false } as HUDState;
    Object.assign(localAir, { localAirFraction: 0.31, localDrowning: false });
    meter.update(state);
    expect(meter.getElement().classList.contains("fps-air-meter--low")).toBe(false);
    localAir.localAirFraction = 0.29;
    meter.update(state);
    expect(meter.getElement().classList.contains("fps-air-meter--low")).toBe(true);
    localAir.localAirFraction = 0.31;
    meter.update(state);
    expect(meter.getElement().classList.contains("fps-air-meter--low")).toBe(false);
    meter.destroy();
  });

  it("hides on our death or full air, catches up on return, and skips unchanged ticks", () => {
    const meter = new FPSAirMeter();
    const state = { localDead: false, dead: false } as HUDState;
    meter.update(state);
    state.localDead = true;
    meter.update(state);
    expect(meter.getElement().style.display).toBe("none");
    state.localDead = false;
    meter.update(state);
    expect(meter.getElement().textContent).toBe("DROWNING");
    expect(meter.getElement().style.display).toBe("");
    localAir.localAirFraction = 1;
    meter.update(state);
    expect(meter.getElement().style.display).toBe("none");
    Object.assign(localAir, { localAirFraction: 0.5, localDrowning: false });
    meter.update(state);
    expect(meter.getElement().style.display).toBe("");
    expect(meter.getElement().textContent).toBe("AIR");

    const observer = new MutationObserver(() => {});
    observer.observe(meter.getElement(), { subtree: true, attributes: true, childList: true, characterData: true });
    for (let tick = 0; tick < 5; tick++) meter.update(state);
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    meter.destroy();
  });
});
