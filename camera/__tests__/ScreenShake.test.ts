import { afterEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { FPSController } from "../FPSController";

const shake = (controller: FPSController) => (controller as unknown as { shakeIntensity: number }).shakeIntensity;

afterEach(() => {
  Cvar.reset("cg_screenshake");
});

describe("screen shake", () => {
  it("shakes by default and not at all with cg_screenshake 0", () => {
    expect(Cvar.getNumber("cg_screenshake")).toBe(1);
    const shaken = new FPSController();
    shaken.shakeCamera(0.4);
    expect(shake(shaken)).toBeCloseTo(0.4);

    Cvar.set("cg_screenshake", 0);
    const still = new FPSController();
    still.shakeCamera(0.4);
    expect(shake(still)).toBe(0);
  });
});
