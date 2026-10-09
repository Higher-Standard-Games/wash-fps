// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Demo starts and the demo's own cameras.
 *
 * A start waits on the live game, the controllers and the map before it takes
 * the screen. Two starts in that window ran side by side, and a stop in it was
 * undone when the load finished (D9). The demo view model owns the draw list
 * while the spectator camera does, and only then (D1).
 */
const cameras = vi.hoisted(() => {
  let active = { type: "freefly" };
  return {
    system: {
      getController: vi.fn(() => ({})),
      getActiveController: vi.fn(() => active),
      setController: vi.fn((type: string) => {
        active = { type };
        return true;
      }),
    },
  };
});

vi.mock("../../../../engine/camera/CameraSystem", () => ({
  CameraSystem: { getInstance: () => cameras.system },
}));
vi.mock("../../../../engine/weapon/WeaponViewManager", () => {
  function WeaponViewManager(): void {}
  WeaponViewManager.getInstance = () => ({ isReady: false });
  return { WeaponViewManager };
});

import { EventBus } from "../../../../engine/core/EventBus";
import { DemoService } from "../DemoService";
import type { DemoViewer } from "../DemoViewer";

interface Internals {
  loadedDemoData: Uint8Array | null;
  activeDemoViewer: unknown;
  _demoWvm: { dispose(): void } | null;
  _followedEntityId: string | null;
  teardownLiveSession(): Promise<void>;
  ensureCinematicControllers(): Promise<void>;
  ensureDemoMapLoaded(): Promise<void>;
  ensureRuntimeWiring(): Promise<void>;
  startPlaybackLoop(): void;
  watchCameraController(): void;
  _attachWeaponViewToSpectatorCam(): void;
}

const service = DemoService.getInstance();
const internals = service as unknown as Internals;

function viewer() {
  return { load: vi.fn(async () => {}), play: vi.fn(), pause: vi.fn(), dispose: vi.fn() };
}

/** Every step of a start stubbed; the map load waits until released. */
function stubStartSteps() {
  const mapLoads: Array<() => void> = [];
  Object.assign(internals, {
    loadedDemoData: new Uint8Array(1),
    teardownLiveSession: async () => {},
    ensureCinematicControllers: async () => {},
    ensureDemoMapLoaded: () => new Promise<void>((resolve) => mapLoads.push(resolve)),
    ensureRuntimeWiring: async () => {},
    startPlaybackLoop: vi.fn(),
  });
  return mapLoads;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("demo starts", () => {
  beforeEach(() => {
    for (const key of [
      "teardownLiveSession",
      "ensureCinematicControllers",
      "ensureDemoMapLoaded",
      "ensureRuntimeWiring",
      "startPlaybackLoop",
      "_attachWeaponViewToSpectatorCam",
    ]) {
      delete (internals as unknown as Record<string, unknown>)[key];
    }
    service.stopAll();
  });

  it("lets the newer of two starts play, and only it", async () => {
    const mapLoads = stubStartSteps();
    const first = viewer();
    const second = viewer();

    const a = service.loadAndPlayNormal(first as unknown as DemoViewer);
    await settle();
    const b = service.loadAndPlayNormal(second as unknown as DemoViewer);
    await settle();
    // The second map load finishes first; the first one's is the late one.
    mapLoads[1]();
    await b;
    mapLoads[0]();
    await a;

    expect(second.play).toHaveBeenCalledOnce();
    expect(first.load).not.toHaveBeenCalled();
    expect(first.play).not.toHaveBeenCalled();
    expect(internals.activeDemoViewer).toBe(second);
  });

  it("stays stopped when stopped while the map loads", async () => {
    const mapLoads = stubStartSteps();
    const demo = viewer();

    const start = service.loadAndPlayNormal(demo as unknown as DemoViewer);
    await settle();
    service.stopAll();
    mapLoads[0]();
    await start;

    expect(demo.play).not.toHaveBeenCalled();
    expect(service.hasActivePlayback()).toBe(false);
  });

  it("stays stopped when stopped while the demo file loads", async () => {
    stubStartSteps();
    Object.assign(internals, { ensureDemoMapLoaded: async () => {} });
    const demo = viewer();
    demo.load.mockImplementation(async () => service.stopAll());

    await service.loadAndPlayNormal(demo as unknown as DemoViewer);

    expect(demo.play).not.toHaveBeenCalled();
    expect(demo.dispose).toHaveBeenCalled();
    expect(service.hasActivePlayback()).toBe(false);
  });

  it("manual playback starts without a second RAF owner or transport HUD", async () => {
    stubStartSteps();
    const wiring = vi.fn(async () => {});
    Object.assign(internals, { ensureDemoMapLoaded: async () => {}, ensureRuntimeWiring: wiring });
    const demo = viewer();
    await service.loadAndPlayNormal(demo as unknown as DemoViewer, { manual: true });
    expect(demo.play).toHaveBeenCalledOnce();
    expect(internals.startPlaybackLoop).not.toHaveBeenCalled();
    expect(wiring).toHaveBeenCalledWith(demo, "normal", false);
  });
  it("counts living recorded actors even when the renderer failed to create any bodies", () => {
    Object.assign(internals, {
      latestState: {
        entities: new Map([
          ["player_1", {}],
          ["player_2", {}],
          ["projectile_3", {}],
        ]),
        events: [{ type: "combat_state", entityId: "player_2", dead: true }],
      },
      remoteRenderer: {
        getPlaybackModelStats: () => ({ alivePlayers: 0, loadedBodies: 0 }),
        setHiddenEntity: vi.fn(),
        dispose: vi.fn(),
      },
    });
    expect(service.getPlaybackModelStats()).toEqual({ alivePlayers: 1, loadedBodies: 0 });
    service.stopAll();
  });
});

describe("the demo view model and camera cuts", () => {
  it("drops its cameras on a cut away from the spectator and comes back with it", () => {
    const wvm = { dispose: vi.fn() };
    const attach = vi.fn();
    Object.assign(internals, { _demoWvm: wvm, _followedEntityId: "player_2", _attachWeaponViewToSpectatorCam: attach });
    internals.watchCameraController();

    EventBus.emit("camera:controller_changed", { type: "freefly" });
    expect(wvm.dispose).toHaveBeenCalledOnce();
    expect(internals._demoWvm).toBeNull();

    EventBus.emit("camera:controller_changed", { type: "spectator" });
    expect(attach).toHaveBeenCalledOnce();

    // Stopping the demo stops listening.
    service.stopAll();
    attach.mockClear();
    EventBus.emit("camera:controller_changed", { type: "spectator" });
    expect(attach).not.toHaveBeenCalled();
    delete (internals as unknown as Record<string, unknown>)._attachWeaponViewToSpectatorCam;
  });
});

describe("switching POV while paused", () => {
  it("shows the new player's gun from the frame on screen", () => {
    const showWeapon = vi.fn();
    const followed = (internals as unknown as { _followed: { showWeapon(id: string, snap: boolean): void } })._followed;
    const original = followed.showWeapon;
    followed.showWeapon = showWeapon;
    Object.assign(internals, {
      _attachWeaponViewToSpectatorCam: vi.fn(),
      latestState: {
        events: [
          { type: "weapon_state", entityId: "player_2", currentWeapon: "rlauncher" },
          { type: "weapon_state", entityId: "player_3", currentWeapon: "railgun" },
        ],
        players: new Map(),
        entities: new Map(),
      },
    });
    try {
      (internals as unknown as { _selectSpectateTarget(id: string): void })._selectSpectateTarget("player_3");
      // Paused, no frame comes to change it: the previous player's gun stayed up (D7).
      expect(showWeapon).toHaveBeenCalledWith("railgun", true);
    } finally {
      followed.showWeapon = original;
      service.stopAll();
      delete (internals as unknown as Record<string, unknown>)._attachWeaponViewToSpectatorCam;
    }
  });
});
