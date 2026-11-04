import { afterEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { FPSController } from "../FPSController";

const shake = (controller: FPSController) => (controller as unknown as { shakeIntensity: number }).shakeIntensity;

afterEach(() => {
  Cvar.reset("cg_screenshake");
  Cvar.reset("cg_hitshake");
});

describe("screen shake", () => {
  it("shakes for explosions by default and not at all with cg_screenshake 0", () => {
    expect(Cvar.getNumber("cg_screenshake")).toBe(1);
    const shaken = new FPSController();
    shaken.shakeCamera(0.4, "explosion");
    expect(shake(shaken)).toBeCloseTo(0.4);

    Cvar.set("cg_screenshake", 0);
    const still = new FPSController();
    still.shakeCamera(0.4, "explosion");
    expect(shake(still)).toBe(0);
  });

  it("shakes for hits only with cg_hitshake 1, which is off by default", () => {
    expect(Cvar.getNumber("cg_hitshake")).toBe(0);
    const still = new FPSController();
    still.shakeCamera(0.3, "hit");
    expect(shake(still)).toBe(0);

    Cvar.set("cg_hitshake", 1);
    Cvar.set("cg_screenshake", 0);
    const shaken = new FPSController();
    shaken.shakeCamera(0.3, "hit");
    expect(shake(shaken)).toBeCloseTo(0.3);
  });
});
