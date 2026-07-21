// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => {
  const spectator = {
    clearSpectateTarget: vi.fn(),
    clearTargetProvider: vi.fn(),
  };
  let activeController: { type: string } = { type: "spectator" };
  const cameraSystem = {
    getController: vi.fn((type: string) => (type === "spectator" ? spectator : type === "freefly" ? {} : undefined)),
    getActiveController: vi.fn(() => activeController),
    setController: vi.fn((type: string) => {
      activeController = { type };
      return true;
    }),
  };
  // The LIVE instance (getInstance) — demo playback owns a separate instance
  // (seeded per generation below); stopAll only asks the live one to re-assert
  // its cameras (QA-8).
  const weaponView = {
    isReady: true,
    reassertCameras: vi.fn(),
  };
  return {
    cameraSystem,
    spectator,
    weaponView,
    setActiveController(type: string) {
      activeController = { type };
    },
  };
});

vi.mock("../../../../engine/camera/CameraSystem", () => ({
  CameraSystem: {
    getInstance: () => lifecycle.cameraSystem,
  },
}));

vi.mock("../../../../engine/weapon/WeaponViewManager", () => {
  // Constructible (DemoService may `new` its own demo instance) with the
  // static live-instance accessor — as a function to satisfy noStaticOnlyClass.
  function WeaponViewManager(): void {}
  WeaponViewManager.getInstance = () => lifecycle.weaponView;
  return { WeaponViewManager };
});

import { DemoService } from "../DemoService";

interface DisposableSpy {
  dispose: ReturnType<typeof vi.fn>;
}

function disposable(rootClass?: string): DisposableSpy {
  const root = rootClass ? document.body.appendChild(document.createElement("div")) : null;
  if (root && rootClass) root.className = rootClass;
  return {
    dispose: vi.fn(() => root?.remove()),
  };
}

function seedPlayback(
  service: DemoService,
  generation: string,
): {
  viewer: DisposableSpy & { pause: ReturnType<typeof vi.fn> };
  cinematic: DisposableSpy;
  renderer: DisposableSpy & { setHiddenEntity: ReturnType<typeof vi.fn> };
  hud: DisposableSpy;
  cinematicHud: DisposableSpy;
  eventOverlay: { destroy: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> };
  gibs: DisposableSpy;
  damage: DisposableSpy;
  drops: DisposableSpy;
  glow: { dispose: ReturnType<typeof vi.fn>; getScene: () => null };
  demoWvm: { dispose: ReturnType<typeof vi.fn> };
} {
  const viewer = { ...disposable(), pause: vi.fn() };
  const cinematic = disposable();
  const renderer = { ...disposable(), setHiddenEntity: vi.fn() };
  const hud = disposable(`demo-hud-${generation}`);
  const cinematicHud = disposable(`cinematic-hud-${generation}`);
  const eventRoot = document.body.appendChild(document.createElement("div"));
  eventRoot.className = `event-overlay-${generation}`;
  const eventOverlay = {
    destroy: vi.fn(() => eventRoot.remove()),
    show: vi.fn(),
    hide: vi.fn(),
  };
  const gibs = disposable();
  const damage = disposable();
  const drops = disposable();
  // A charge glow is disposed via disposeClusteredLight (WS1), which reads
  // light.getScene() to detach from the cluster — return null (unclustered).
  const glow = { dispose: vi.fn(), getScene: () => null };
  const demoWvm = { dispose: vi.fn(), clearDemoBob: vi.fn(), setVisible: vi.fn() };

  Object.assign(service as unknown as Record<string, unknown>, {
    _demoWvm: demoWvm,
    activeDemoViewer: viewer,
    activeCinematicPlayer: cinematic,
    remoteRenderer: renderer,
    demoHud: hud,
    cinematicHud,
    demoEventOverlay: eventOverlay,
    demoGibs: gibs,
    demoDamageNumbers: damage,
    droppedWeaponRenderer: drops,
    latestState: {},
    _followedEntityId: `player_${generation}`,
    _followedDead: true,
    _lastDemoWeapon: "rocket",
  });
  const internals = service as unknown as {
    demoOverlays: {
      bindKeyboard(target: Document): void;
      setNormalHud(overlay: { show(): void; hide(): void }): void;
      setCinematicHud(overlay: { show(): void; hide(): void }): void;
      setChat(overlay: { show(): void; hide(): void }): void;
    };
    chargingGlows: Map<string, { dispose(): void; getScene(): null }>;
    chargingPlayers: Set<string>;
    _enemyWeapons: Map<string, string>;
  };
  internals.demoOverlays.bindKeyboard(document);
  internals.demoOverlays.setNormalHud({ show: vi.fn(), hide: vi.fn() });
  internals.demoOverlays.setCinematicHud({ show: vi.fn(), hide: vi.fn() });
  internals.demoOverlays.setChat(eventOverlay);
  internals.chargingGlows.set(`player_${generation}`, glow);
  internals.chargingPlayers.add(`player_${generation}`);
  internals._enemyWeapons.set(`player_${generation}`, "rocket");
  lifecycle.setActiveController("spectator");

  return { viewer, cinematic, renderer, hud, cinematicHud, eventOverlay, gibs, damage, drops, glow, demoWvm };
}

describe("DemoService playback lifecycle", () => {
  const service = DemoService.getInstance();

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    lifecycle.setActiveController("spectator");
    service.stopAll();
    vi.clearAllMocks();
  });

  it("fully releases consecutive normal and cinematic playback generations", () => {
    const normal = seedPlayback(service, "normal");
    (service as unknown as { stopForPlaybackTransition(): void }).stopForPlaybackTransition();

    expect(normal.viewer.pause).toHaveBeenCalledOnce();
    for (const owner of [
      normal.viewer,
      normal.cinematic,
      normal.renderer,
      normal.hud,
      normal.cinematicHud,
      normal.gibs,
      normal.damage,
      normal.drops,
    ]) {
      expect(owner.dispose).toHaveBeenCalledOnce();
    }
    expect(normal.renderer.setHiddenEntity).toHaveBeenCalledWith(null);
    expect(normal.eventOverlay.destroy).toHaveBeenCalledOnce();
    expect(normal.glow.dispose).toHaveBeenCalledOnce();
    expect(document.querySelector('[class$="-normal"]')).toBeNull();

    const cinematic = seedPlayback(service, "cinematic");
    service.stopAll();

    expect(cinematic.viewer.pause).toHaveBeenCalledOnce();
    expect(cinematic.cinematic.dispose).toHaveBeenCalledOnce();
    expect(cinematic.renderer.setHiddenEntity).toHaveBeenCalledWith(null);
    expect(cinematic.eventOverlay.destroy).toHaveBeenCalledOnce();
    expect(document.querySelector('[class$="-cinematic"]')).toBeNull();
    expect(lifecycle.spectator.clearSpectateTarget).toHaveBeenCalledTimes(2);
    expect(lifecycle.spectator.clearTargetProvider).toHaveBeenCalledTimes(2);
    expect(lifecycle.cameraSystem.setController).toHaveBeenCalledTimes(2);
    // Each generation's OWN demo viewmodel instance is disposed and released;
    // the live instance is only asked to re-assert its cameras (QA-8).
    expect(normal.demoWvm.dispose).toHaveBeenCalledOnce();
    expect(cinematic.demoWvm.dispose).toHaveBeenCalledOnce();
    expect((service as unknown as { _demoWvm: unknown })._demoWvm).toBeNull();
    expect(lifecycle.weaponView.reassertCameras).toHaveBeenCalledTimes(2);
  });

  it("removes the global HUD key listener and clears playback identity", () => {
    seedPlayback(service, "cleanup");
    service.stopAll();

    expect(service.hasActivePlayback()).toBe(false);
    expect(service.isDemoOverlayVisible()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyH" }));
    expect(service.isDemoOverlayVisible()).toBe(true);

    const internals = service as unknown as {
      latestState: unknown;
      _followedEntityId: string | null;
      _lastDemoWeapon: string | null;
      _enemyWeapons: Map<string, string>;
      chargingPlayers: Set<string>;
      chargingGlows: Map<string, unknown>;
    };
    expect(internals.latestState).toBeNull();
    expect(internals._followedEntityId).toBeNull();
    expect(internals._lastDemoWeapon).toBeNull();
    expect(internals._enemyWeapons.size).toBe(0);
    expect(internals.chargingPlayers.size).toBe(0);
    expect(internals.chargingGlows.size).toBe(0);
  });
});
