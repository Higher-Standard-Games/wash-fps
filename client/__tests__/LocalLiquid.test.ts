import { beforeEach, describe, expect, it, vi } from "vitest";

/** LocalLiquid's life cycle and wiring, as it worked inside Game. */

const made: { views: any[]; interactions: any[]; trackers: any[] } = { views: [], interactions: [], trackers: [] };
let waterQuality: number | undefined = 3;
let crownsAvailable = true;
const weaponView = { submersionAmount: 0 };
const sounds: string[] = [];

vi.mock("../../liquid/client/UnderwaterView", () => ({
  UnderwaterView: class {
    onSubmersion: ((amount: number) => void) | null = null;
    submersionAmount = 0.25;
    start = vi.fn();
    dispose = vi.fn();
    setCollisionWorld = vi.fn();
    constructor(public scene: unknown) {
      made.views.push(this);
    }
  },
}));
vi.mock("../../liquid/client/LiquidInteractionSystem", () => ({
  LiquidInteractionSystem: class {
    notify = vi.fn();
    notifyProjectile = vi.fn();
    forget = vi.fn();
    forgetProjectile = vi.fn();
    dispose = vi.fn();
    setCollisionWorld = vi.fn();
    enableCrowns = vi.fn(() => crownsAvailable);
    constructor(public scene: unknown) {
      made.interactions.push(this);
    }
  },
}));
vi.mock("../../liquid/client/LocalAirTracker", () => ({
  LocalAirTracker: class {
    air = 0.5;
    drowning = true;
    onStartedDrowning: unknown = null;
    onDrownTick: unknown = null;
    reset = vi.fn();
    update = vi.fn();
    constructor() {
      made.trackers.push(this);
    }
  },
}));
vi.mock("../../../../engine/rendering/RenderVars", () => ({
  default: { getInstance: () => ({ get: () => waterQuality }) },
}));
vi.mock("../../../../engine/weapon/WeaponViewManager", () => ({ getWeaponViewManager: () => weaponView }));
vi.mock("../FPSLiquidAudio", () => ({ playDrownGasp: () => {}, playDrownTick: () => {} }));
vi.mock("../FPSMovementAudio", () => ({ playJumppadLaunch: () => sounds.push("jumppad") }));

const { LocalLiquid } = await import("../LocalLiquid");
const { playDrownGasp, playDrownTick } = await import("../FPSLiquidAudio");

function v2(movement: { waterLevel: number; jumppadLaunch: boolean }) {
  return {
    getState: () => ({ position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: -50, z: 0 } }),
    getMovementState: () => movement,
  } as never;
}

describe("LocalLiquid", () => {
  beforeEach(() => {
    made.views.length = 0;
    made.interactions.length = 0;
    made.trackers.length = 0;
    waterQuality = 3;
    crownsAvailable = true;
    sounds.length = 0;
  });

  it("is inert before a map starts, apart from the jump-pad sound", () => {
    const liquid = new LocalLiquid();
    expect(liquid.interactions).toBeNull();
    expect(liquid.airFraction).toBe(1);
    expect(liquid.drowning).toBe(false);
    expect(liquid.cameraSubmersion).toBe(0);
    liquid.forgetLocal();
    liquid.emitLocalCrossing(v2({ waterLevel: 2, jumppadLaunch: true }));
    expect(sounds).toEqual(["jumppad"]); // the sound needs only prediction, not water
  });

  it("starts the view, splashes and air for a scene, and hands splashes to the remote renderer", () => {
    const liquid = new LocalLiquid();
    const remote = { liquidInteractions: null as unknown };
    liquid.start("scene" as never, remote as never);
    const [view] = made.views;
    const [interactions] = made.interactions;
    const [tracker] = made.trackers;
    expect(view.scene).toBe("scene");
    expect(view.start).toHaveBeenCalled();
    expect(remote.liquidInteractions).toBe(interactions);
    expect(liquid.interactions).toBe(interactions);
    expect(interactions.enableCrowns).toHaveBeenCalled();
    expect(tracker.onStartedDrowning).toBe(playDrownGasp);
    expect(tracker.onDrownTick).toBe(playDrownTick);
    view.onSubmersion(0.7);
    expect(weaponView.submersionAmount).toBe(0.7);
    expect(liquid.cameraSubmersion).toBe(0.25);
    expect(liquid.airFraction).toBe(0.5);
    expect(liquid.drowning).toBe(true);
  });

  it("disposes the previous map's view and splashes when a new map starts", () => {
    const liquid = new LocalLiquid();
    liquid.start("a" as never, null);
    liquid.start("b" as never, null);
    expect(made.views[0].dispose).toHaveBeenCalled();
    expect(made.interactions[0].dispose).toHaveBeenCalled();
    expect(liquid.interactions).toBe(made.interactions[1]);
  });

  it("skips splash crowns on Low water quality", () => {
    waterQuality = 1;
    new LocalLiquid().start("scene" as never, null);
    expect(made.interactions[0].enableCrowns).not.toHaveBeenCalled();
  });

  it("passes the collision world to the view and the splashes", () => {
    const liquid = new LocalLiquid();
    liquid.start("scene" as never, null);
    liquid.setCollisionWorld("world" as never);
    expect(made.views[0].setCollisionWorld).toHaveBeenCalledWith("world");
    expect(made.interactions[0].setCollisionWorld).toHaveBeenCalledWith("world");
  });

  it("reports the local crossing and air from prediction, and plays the jump pad once per launch", () => {
    const liquid = new LocalLiquid();
    liquid.start("scene" as never, null);
    const movement = { waterLevel: 2, jumppadLaunch: true };
    liquid.emitLocalCrossing(v2(movement));
    liquid.emitLocalCrossing(v2(movement));
    expect(sounds).toEqual(["jumppad"]);
    movement.jumppadLaunch = false;
    liquid.emitLocalCrossing(v2(movement));
    movement.jumppadLaunch = true;
    liquid.emitLocalCrossing(v2(movement));
    expect(sounds).toEqual(["jumppad", "jumppad"]);
    expect(made.interactions[0].notify).toHaveBeenLastCalledWith("local", 2, "water", { x: 1, y: 2, z: 3 }, -50, true);
    expect(made.trackers[0].update).toHaveBeenCalledWith(2, expect.any(Number));
    liquid.emitLocalCrossing(null);
    expect(made.interactions[0].notify).toHaveBeenCalledTimes(4);
  });

  it("stops breathing for a dead body sinking in prediction", () => {
    const liquid = new LocalLiquid();
    liquid.start("scene" as never, null);
    liquid.emitLocalCrossing(v2({ waterLevel: 3, jumppadLaunch: false }), true);
    // The mirror kept counting down over the corpse: gasp, then gurgles (L4).
    expect(made.trackers[0].update).not.toHaveBeenCalled();
  });

  it("forgets, resets and debug-splashes through the current systems", () => {
    const liquid = new LocalLiquid();
    liquid.start("scene" as never, null);
    const [interactions] = made.interactions;
    liquid.forgetProjectile("proj_1");
    liquid.forgetLocal();
    liquid.resetAir();
    liquid.debugSplash({ x: 0, y: 0, z: 0 });
    expect(interactions.forgetProjectile).toHaveBeenCalledWith("proj_1");
    expect(interactions.forget).toHaveBeenCalledWith("local");
    expect(made.trackers[0].reset).toHaveBeenCalled();
    expect(interactions.notify.mock.calls.map((c: unknown[]) => c[1])).toEqual([0, 2]);
  });
});
