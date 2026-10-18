// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { Crosshair } from "../Crosshair";

let strokes: string[];
let context: CanvasRenderingContext2D;
beforeEach(() => {
  strokes = [];
  context = {
    strokeStyle: "",
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke(this: CanvasRenderingContext2D) {
      strokes.push(String(this.strokeStyle));
    },
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
  Object.defineProperty(document, "pointerLockElement", { configurable: true, value: document.body });
  Cvar.reset("cg_crosshairSize");
  Cvar.set("cg_crosshair", 1);
});
afterEach(() => {
  Crosshair.getInstance().dispose();
  Reflect.deleteProperty(document, "pointerLockElement");
  Cvar.reset("cg_crosshairSize");
  vi.restoreAllMocks();
});

describe("crosshair ammo feedback", () => {
  it("shows a graphical red X from the HUD's equipped weapon and restores the reticle on refill", () => {
    const crosshair = Crosshair.getInstance();
    crosshair.init();
    const hud = { currentWeapon: "rlauncher", ammo: { rlauncher: 0, machinegun: { clip: 30, reserve: 90 } } };
    crosshair.notifyHit();
    crosshair.updateFromHUD(0, 0, hud, false, true);
    expect(strokes).toContain("rgba(255, 40, 40, 0.9)");
    expect(context.fillRect).not.toHaveBeenCalled();
    hud.ammo.rlauncher = 1;
    strokes.length = 0;
    crosshair.updateFromHUD(0, 0, hud, false, true);
    expect(strokes).not.toContain("rgba(255, 40, 40, 0.9)");
    expect(context.fillRect).toHaveBeenCalled();
  });
  it("defaults to 32, honors custom sizes, and does not mark reloadable weapons or the blade empty", () => {
    const crosshair = Crosshair.getInstance();
    crosshair.init();
    expect(document.querySelector("canvas")?.width).toBe(64);
    Cvar.set("cg_crosshairSize", 40);
    crosshair.updateFromHUD(
      0,
      0,
      { currentWeapon: "machinegun", ammo: { machinegun: { clip: 0, reserve: 10 } } },
      false,
      true,
    );
    crosshair.updateFromHUD(0, 0, { currentWeapon: "blade", ammo: {} }, false, true);
    expect(document.querySelector("canvas")?.width).toBe(80);
    expect(strokes).not.toContain("rgba(255, 40, 40, 0.9)");
  });
});
