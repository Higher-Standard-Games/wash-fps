// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SpectateView's teammate hand-off, cycling and round-end camera, as they
 * worked inside Game. The cameras themselves are swapped for spies: what is
 * pinned here is who gets watched and when, not how the camera moves.
 */

const viewWeapon = { setVisible: vi.fn(), isReady: true, init: vi.fn() };
const powerups = { cleared: 0 };
vi.mock("../LocalPowerupState", () => ({ clearLocalPowerups: () => powerups.cleared++ }));
vi.mock("../../../../engine/weapon/WeaponViewManager", () => ({ getWeaponViewManager: () => viewWeapon }));
const cameraSystem = {
  getCamera: () => ({ rotation: { x: 0.1, y: 1.5 } }),
  getFreeCamera: () => ({ getScene: () => "scene" }),
  setController: vi.fn(),
  getController: vi.fn(() => null),
  registerController: vi.fn(),
};
vi.mock("../../../../engine/camera", () => ({ CameraSystem: { getInstance: () => cameraSystem } }));
vi.mock("../../../../engine/camera/CameraSystem", () => ({ CameraSystem: { getInstance: () => cameraSystem } }));
vi.mock("../../../../engine/camera/controllers/FreeflyController", () => ({ FreeflyController: class {} }));

const { SPECTATE_AFTER_DEATH_MS, SpectateView } = await import("../SpectateView");
const { MatchPhase, MatchStateManager } = await import("../MatchStateManager");
const { HUDState } = await import("../HUDState");
const { PlayerWeaponStates } = await import("../SnapshotStateStore");

type Rendered = Map<string, { position: { x: number; y: number; z: number }; dead: boolean }>;

function entity(x: number, yaw: number, crouchViewOffset = 0) {
  const components: Record<string, unknown> = {
    transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0.2, y: yaw } },
    movementState: { crouchViewOffset },
  };
  return { getComponent: (name: string) => components[name] };
}

function drawnSample(x: number, yaw: number, crouchViewOffset = 0) {
  return {
    x,
    y: 0,
    z: 0,
    yaw,
    pitch: 0.2,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: true,
    crouching: crouchViewOffset < 0,
    sliding: false,
    wallJumping: false,
    crouchViewOffset,
  };
}

function setup() {
  const state = { dead: true, playerState: "playing" as "spectator" | "playing" };
  const rendered: Rendered = new Map([
    ["player_1", { position: { x: 0, y: 0, z: 0 }, dead: true }],
    ["player_3", { position: { x: 3, y: 0, z: 0 }, dead: false }],
    ["player_2", { position: { x: 2, y: 0, z: 0 }, dead: false }],
    ["player_9", { position: { x: 9, y: 0, z: 0 }, dead: false }],
  ]);
  // What each player is drawn from this frame: the watched view's source.
  const samples = new Map([
    ["player_2", drawnSample(2, 0.5, -10)],
    ["player_3", drawnSample(3, 0.7)],
  ]);
  const remoteRenderer = {
    getRenderedPlayers: () => rendered,
    setHiddenEntity: vi.fn(),
    getEntitySample: (id: string) => samples.get(id) ?? null,
  };
  const enemyWeapons = new Map([["player_2", "riotgun"]]);
  const playerWeapons = new PlayerWeaponStates();
  const overlay = { setMode: vi.fn(), setSpectatingTarget: vi.fn() };
  // A spectator's list of who can be chased, in the order it cycles.
  const cycling = {
    order: ["player_2", "player_3", "player_9"],
    target: null as string | null,
    alive: new Set(["player_2", "player_3", "player_9"]),
    setTarget: vi.fn((id: string) => {
      cycling.target = id;
    }),
    clearTarget: vi.fn(() => {
      cycling.target = null;
    }),
    getTargetEntityId: () => cycling.target,
    isAlive: (id: string) => cycling.alive.has(id),
    getPlayerName: (id: string) => `name:${id}`,
    step(direction: number) {
      const n = cycling.order.length;
      let at = cycling.target ? cycling.order.indexOf(cycling.target) : direction > 0 ? -1 : n;
      for (let i = 0; i < n; i++) {
        at = (at + direction + n) % n;
        if (cycling.alive.has(cycling.order[at])) return cycling.order[at];
      }
      return null;
    },
    next: vi.fn(() => cycling.step(1)),
    prev: vi.fn(() => cycling.step(-1)),
  };
  const controller = {
    target: null as string | null,
    setSpectateTarget: vi.fn((id: string) => {
      controller.target = id;
    }),
    clearSpectateTarget: vi.fn(() => {
      controller.target = null;
    }),
    getTargetEntityId: () => controller.target,
  };
  const gameState = {
    entities: new Map([
      ["player_2", entity(2, 0.5, -10)],
      ["player_3", entity(3, 0.7)],
    ]),
    players: new Map([["player_2", { entityId: "player_2", name: "Alice" }]]),
  };
  const view = new SpectateView({
    isPlayerDead: () => state.dead,
    playerState: () => state.playerState,
    localPlayerId: () => "player_1",
    latestGameState: () => gameState as never,
    remoteRenderer: () => remoteRenderer as never,
    spectatorOverlay: () => overlay as never,
    spectatorCycling: () => cycling as never,
    spectatorController: () => controller as never,
    enemyWeapons: () => enemyWeapons,
    playerWeapons: () => playerWeapons,
  });
  const deathCamera = { start: vi.fn(), stop: vi.fn(), update: vi.fn(() => false) };
  const eyeCamera = { start: vi.fn(), stop: vi.fn(), update: vi.fn(() => false) };
  const followed = {
    followedEntityId: null as string | null,
    presentation: null,
    follow: vi.fn((id: string | null) => {
      followed.followedEntityId = id;
    }),
    showWeapon: vi.fn(),
    updateMotion: vi.fn(),
  };
  Object.assign(view, { _deathCamera: deathCamera, _eyeCamera: eyeCamera, _followedWeapon: followed });
  return {
    view,
    state,
    rendered,
    remoteRenderer,
    samples,
    overlay,
    gameState,
    deathCamera,
    eyeCamera,
    cycling,
    controller,
    followed,
    playerWeapons,
  };
}

function match(phase: number, round: number, extra: Record<string, unknown> = {}) {
  MatchStateManager.destroy();
  MatchStateManager.getInstance().processEvent({
    type: "match_state",
    phase,
    round,
    playerTeams: { 1: "red", 2: "red", 3: "red", 9: "blue" }, // keyed by bare id, as on the wire
    ...extra,
  });
}

const camera = () =>
  ({ rotation: { x: 0, y: 0, z: 0.7 }, position: { x: 0, y: 0, z: 0 }, setTarget: vi.fn() }) as never;

let now = 0;

describe("SpectateView", () => {
  beforeEach(() => {
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    viewWeapon.setVisible.mockClear();
    viewWeapon.init.mockClear();
    viewWeapon.isReady = true;
    powerups.cleared = 0;
    cameraSystem.setController.mockClear();
    cameraSystem.registerController.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    MatchStateManager.destroy();
  });

  it("stays on the corpse, then hands over to the first living teammate in a live round", () => {
    const { view, remoteRenderer, overlay, eyeCamera, deathCamera } = setup();
    match(MatchPhase.Active, 1);

    view.applyDeathCamera(camera(), 1 / 60); // the death is stamped on this frame
    now += SPECTATE_AFTER_DEATH_MS - 1;
    view.applyDeathCamera(camera(), 1 / 60);
    expect(view._spectatingEntityId).toBeNull();

    now += 1;
    view.applyDeathCamera(camera(), 1 / 60);
    // Map order, skipping our own hidden body and the enemy.
    expect(view._spectatingEntityId).toBe("player_3");
    expect(remoteRenderer.setHiddenEntity).toHaveBeenCalledWith("player_3");
    expect(eyeCamera.start).toHaveBeenCalled();
    expect(deathCamera.stop).toHaveBeenCalled();
    expect(overlay.setMode).toHaveBeenCalledWith("first-person");
    expect(overlay.setSpectatingTarget).toHaveBeenCalledWith("Player 3");
  });

  it("names a watched player from the snapshot's roster when it has them", () => {
    const { view, overlay, rendered } = setup();
    rendered.delete("player_3");
    match(MatchPhase.Active, 1);
    view.applyDeathCamera(camera(), 1 / 60);
    now += SPECTATE_AFTER_DEATH_MS;
    view.applyDeathCamera(camera(), 1 / 60);
    expect(view._spectatingEntityId).toBe("player_2");
    expect(overlay.setSpectatingTarget).toHaveBeenCalledWith("Alice");
  });

  it("refuses a teammate it has no position for, and keeps the corpse camera", () => {
    const { view, samples, deathCamera } = setup();
    // No sample to draw them from, and (stood in for here) no longer drawn either.
    samples.clear();
    match(MatchPhase.Active, 1);
    Object.assign(view as object, { drawnAt: () => null });
    view.applyDeathCamera(camera(), 1 / 60);
    now += SPECTATE_AFTER_DEATH_MS;
    view.applyDeathCamera(camera(), 1 / 60);
    expect(view._spectatingEntityId).toBeNull();
    expect(deathCamera.stop).not.toHaveBeenCalled();
  });

  it("cycles living teammates in sorted order and wraps", () => {
    const { view } = setup();
    match(MatchPhase.Active, 1);
    view._spectatingEntityId = "player_2";
    view.cycleTeammateSpectate(1);
    expect(view._spectatingEntityId).toBe("player_3");
    view.cycleTeammateSpectate(1);
    expect(view._spectatingEntityId).toBe("player_2");
    view.cycleTeammateSpectate(-1);
    expect(view._spectatingEntityId).toBe("player_3");
  });

  it("does not cycle when nobody is being watched", () => {
    const { view } = setup();
    match(MatchPhase.Active, 1);
    view.cycleTeammateSpectate(1);
    expect(view._spectatingEntityId).toBeNull();
  });

  it("views from the sample the player is drawn with, at their crouched eye height", () => {
    const { view } = setup();
    const crouched = view.eyePose("player_2");
    expect(crouched).toMatchObject({ x: 2, z: 0, yaw: 0.5, pitch: 0.2 });
    const standing = view.eyePose("player_3");
    expect((standing?.y ?? 0) - (crouched?.y ?? 0)).toBe(10);
    expect(view.eyePose("player_9")).toBeNull();
  });

  it("turns the round-end camera on the focus and drops the teammate view", () => {
    const { view, remoteRenderer, deathCamera, eyeCamera } = setup();
    view._spectatingEntityId = "player_2";
    match(MatchPhase.RoundEnd, 1, { roundResult: { focus: { x: 5, y: 6, z: 7 } } });

    view.applyDeathCamera(camera(), 1 / 60);
    expect(eyeCamera.stop).toHaveBeenCalled();
    expect(remoteRenderer.setHiddenEntity).toHaveBeenCalledWith(null);
    // Still dead, so the borrowed view weapon goes away again.
    expect(viewWeapon.setVisible).toHaveBeenCalledWith(false);
    const [, target, yaw] = deathCamera.start.mock.calls[0] as unknown as [unknown, { x: number }, number];
    expect(target.x).toBe(5);
    expect(yaw).toBe(1.5);

    view.applyDeathCamera(camera(), 1 / 60);
    expect(deathCamera.start).toHaveBeenCalledTimes(1);
  });

  it("releases the round-end camera once the next round revives the player", () => {
    const { view, state, deathCamera } = setup();
    match(MatchPhase.RoundEnd, 1, { roundResult: { focus: { x: 5, y: 6, z: 7 } } });
    view.applyDeathCamera(camera(), 1 / 60);
    state.dead = false;
    match(MatchPhase.Countdown, 2);
    view.applyDeathCamera(camera(), 1 / 60);
    expect(deathCamera.stop).toHaveBeenCalled();
  });

  it("claims the frame and levels the roll while dead in a round with no picture", () => {
    const { view } = setup();
    match(MatchPhase.Countdown, 1);
    const cam = camera() as unknown as { rotation: { z: number } };
    expect(view.applyDeathCamera(cam as never, 1 / 60)).toBe(true);
    expect(cam.rotation.z).toBe(0);
  });

  it("leaves the frame to the controller when alive and watching nobody", () => {
    const { view, state } = setup();
    state.dead = false;
    match(MatchPhase.Active, 1);
    expect(view.applyDeathCamera(camera(), 1 / 60)).toBe(false);
  });

  describe("chase camera", () => {
    it("follows a player from behind their eyes, with their model hidden", () => {
      const { view, cycling, controller, remoteRenderer, overlay } = setup();
      view.spectatePlayer("player_3");
      expect(cycling.target).toBe("player_3");
      expect(controller.target).toBe("player_3");
      expect(remoteRenderer.setHiddenEntity).toHaveBeenCalledWith("player_3");
      expect(overlay.setMode).toHaveBeenCalledWith("first-person");
      expect(overlay.setSpectatingTarget).toHaveBeenCalledWith("name:player_3");
      expect(cameraSystem.setController).toHaveBeenCalledWith("spectator");
    });

    it("steps forward and back through the cycling list", () => {
      const { view, controller } = setup();
      view.nextSpectateTarget();
      expect(controller.target).toBe("player_2");
      view.nextSpectateTarget();
      expect(controller.target).toBe("player_3");
      view.prevSpectateTarget();
      expect(controller.target).toBe("player_2");
    });

    it("returns to freefly, showing the player again, on exit", async () => {
      const { view, cycling, controller, remoteRenderer, overlay } = setup();
      view.spectatePlayer("player_3");
      view.exitChaseCam();
      expect(cycling.target).toBeNull();
      expect(controller.target).toBeNull();
      expect(remoteRenderer.setHiddenEntity).toHaveBeenLastCalledWith(null);
      expect(overlay.setMode).toHaveBeenLastCalledWith("freefly");
      await vi.waitFor(() => expect(cameraSystem.setController).toHaveBeenLastCalledWith("freefly"));
      expect(cameraSystem.registerController).toHaveBeenCalledWith("freefly", expect.anything());
    });

    it("waits on a dead target through the respawn, then moves on", () => {
      const { view, cycling, controller } = setup();
      match(MatchPhase.Active, 0); // a mode with respawns
      view.spectatePlayer("player_3");
      cycling.alive.delete("player_3");

      view.syncChaseTarget(); // first seen dead
      now += 7999;
      view.syncChaseTarget();
      expect(controller.target).toBe("player_3");
      now += 1;
      view.syncChaseTarget();
      expect(controller.target).toBe("player_9");
    });

    it("moves on sooner in a round mode, where the dead stay down", () => {
      const { view, cycling, controller } = setup();
      match(MatchPhase.Active, 2);
      view.spectatePlayer("player_3");
      cycling.alive.delete("player_3");
      view.syncChaseTarget();
      now += SPECTATE_AFTER_DEATH_MS;
      view.syncChaseTarget();
      expect(controller.target).toBe("player_9");
    });

    it("keeps waiting from scratch if the target comes back before the wait ends", () => {
      const { view, cycling, controller } = setup();
      match(MatchPhase.Active, 0);
      view.spectatePlayer("player_3");
      cycling.alive.delete("player_3");
      view.syncChaseTarget();
      now += 5000;
      cycling.alive.add("player_3"); // respawned
      view.syncChaseTarget();
      cycling.alive.delete("player_3");
      view.syncChaseTarget();
      now += 5000;
      view.syncChaseTarget();
      expect(controller.target).toBe("player_3");
    });

    it("picks up whoever the list moved to, and leaves when the list is empty", () => {
      const { view, cycling, controller, overlay } = setup();
      view.spectatePlayer("player_3");
      cycling.target = "player_2"; // the list moved on by itself
      view.syncChaseTarget();
      expect(controller.target).toBe("player_2");

      cycling.target = null;
      view.syncChaseTarget();
      expect(controller.target).toBeNull();
      expect(overlay.setMode).toHaveBeenLastCalledWith("freefly");
    });

    it("does nothing while not chasing anyone", () => {
      const { view, cycling, controller } = setup();
      cycling.target = "player_2";
      view.syncChaseTarget();
      expect(controller.target).toBeNull();
    });
  });

  describe("whose view it is", () => {
    it("is the teammate while dead, the chase target while spectating, and our own otherwise", () => {
      const { view, state, controller } = setup();
      controller.target = "player_9";
      expect(view.spectatingEntityId).toBeNull();
      state.playerState = "spectator";
      expect(view.spectatingEntityId).toBe("player_9");
      view._spectatingEntityId = "player_2";
      expect(view.spectatingEntityId).toBe("player_2");
    });

    it("puts the watched player's known weapon up once, when the view moves to them", () => {
      const { view, followed, rendered } = setup();
      rendered.get("player_2")!.dead = true;
      view._spectatingEntityId = "player_2";
      view.syncFollowedSubject();
      view.syncFollowedSubject();
      expect(followed.follow).toHaveBeenCalledTimes(1);
      expect(followed.follow).toHaveBeenCalledWith("player_2", true);
      expect(followed.showWeapon).toHaveBeenCalledWith("riotgun");
      expect(powerups.cleared).toBe(1);
    });

    it("puts the new target's stored gun and ammo up at once, not the last target's", () => {
      const { view, followed, playerWeapons } = setup();
      playerWeapons.set({
        type: "weapon_state",
        entityId: "player_2",
        currentWeapon: "machinegun",
        weapons: ["blade", "machinegun"],
        ammo: { machinegun: { clip: 17, reserve: 90 } },
        reloading: false,
        lastFireTick: 0,
      });
      const hud = vi.spyOn(HUDState.getInstance(), "processWeaponState");
      view._spectatingEntityId = "player_2";
      view.syncFollowedSubject();
      expect(followed.showWeapon).toHaveBeenCalledWith("machinegun", false);
      expect(hud).toHaveBeenCalledWith({
        currentWeapon: "machinegun",
        weapons: ["blade", "machinegun"],
        ammo: { machinegun: { clip: 17, reserve: 90 } },
      });
    });

    it("drops the gun for a spectator flying free, but leaves a player's own", () => {
      const { view, state, followed } = setup();
      view._spectatingEntityId = "player_2";
      view.syncFollowedSubject();
      view._spectatingEntityId = null;
      view.syncFollowedSubject();
      expect(followed.follow).toHaveBeenLastCalledWith(null);
      expect(viewWeapon.setVisible).not.toHaveBeenCalled();

      const spectator = setup();
      spectator.state.playerState = "spectator";
      spectator.controller.target = "player_3";
      spectator.view.syncFollowedSubject();
      spectator.controller.target = null;
      spectator.view.syncFollowedSubject();
      expect(viewWeapon.setVisible).toHaveBeenCalledWith(false);
      expect(state.playerState).toBe("playing");
    });

    it("builds the view weapon for a spectator who never joined", () => {
      const { view, state, controller } = setup();
      viewWeapon.isReady = false;
      state.playerState = "spectator";
      controller.target = "player_3";
      view.syncFollowedSubject();
      expect(viewWeapon.init).toHaveBeenCalledWith("scene", expect.anything());
    });

    it("feeds the watched player's stride to their weapon", () => {
      const { view, followed, samples } = setup();
      view.updateFollowedMotion();
      expect(followed.updateMotion).not.toHaveBeenCalled();
      followed.followedEntityId = "player_2";
      view.updateFollowedMotion();
      expect(followed.updateMotion).toHaveBeenCalledWith(samples.get("player_2"), expect.anything());
    });
  });
});
