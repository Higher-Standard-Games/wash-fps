// @vitest-environment jsdom

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { FPSController } from "../../camera/FPSController";
import { WEAPONS } from "../../shared/entities/definitions/weapons/WeaponsTable";
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
  it("retains the ammo-aware reticle through the remainder of an FPS camera frame", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("ammo-test", Vector3.Zero(), scene);
    const crosshair = Crosshair.getInstance();
    crosshair.init();
    context.clearRect = vi.fn(() => {
      strokes.length = 0;
    });
    const hud = { currentWeapon: "voltaic", ammo: { voltaic: { clip: 0, reserve: 0 } } };
    const controller = new FPSController();
    Object.assign(controller, {
      camera,
      scene,
      smoothingInitialized: true,
      networkReady: true,
      useNetworkMovement: true,
      gameManager: {
        processSnapshots: vi.fn(),
        renderRemotePlayers: () => crosshair.updateFromHUD(0, 0, hud, false, true),
        getLocalPlayerPosition: () => null,
        getCurrentMovementState: () => null,
        getCurrentWeaponId: () => "voltaic",
        isConnectedToServer: () => true,
        isPlayerDead: () => false,
      },
      _crosshairReady: true,
      _crosshair: crosshair,
      _weaponsMap: WEAPONS,
      _gibSystem: { update: vi.fn() },
      _damageNumbers: { update: vi.fn() },
    });
    try {
      controller.update(0.001);
      expect(strokes.at(-1)).toBe("rgba(255, 40, 40, 0.9)");
      hud.ammo.voltaic.clip = 1;
      controller.update(0.001);
      expect(strokes).not.toContain("rgba(255, 40, 40, 0.9)");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
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

  it("repaints only when the reticle changes", () => {
    const crosshair = Crosshair.getInstance();
    crosshair.init();
    const hud = { currentWeapon: "blade", ammo: {} };
    crosshair.updateFromHUD(0, 0, hud, false, true);
    crosshair.updateFromHUD(0, 0, hud, false, true);
    expect(context.clearRect).toHaveBeenCalledTimes(1);
    crosshair.updateFromHUD(0, 400, hud, false, true);
    expect(context.clearRect).toHaveBeenCalledTimes(2);
  });
});
