import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InterpolatedEntity } from "../../../../engine/network/client/SnapshotBuffer";
import type { WeaponViewManager } from "../../../../engine/weapon/WeaponViewManager";
import { FollowedViewWeapon } from "../FollowedViewWeapon";

/** The calls the helper makes, without a Babylon scene behind them. */
function makeView() {
  const view = {
    isReady: true,
    displayed: null as string | null,
    getDisplayedWeaponId: vi.fn(() => view.displayed),
    loadWeapon: vi.fn(async (id: string) => {
      view.displayed = id;
      return true;
    }),
    switchWeaponAnimated: vi.fn(async (id: string) => {
      view.displayed = id;
    }),
    cancelSwitch: vi.fn(),
    clearFollowedBob: vi.fn(),
    updateFollowedBob: vi.fn(),
    setVisible: vi.fn(),
    presentFire: vi.fn(),
    getProjectileMuzzlePosition: vi.fn(() => ({ x: 1, y: 2, z: 3 })),
  };
  return view;
}

function running(vx: number): InterpolatedEntity {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    vx,
    vy: 0,
    vz: 0,
    grounded: true,
    crouching: false,
    sliding: false,
    wallJumping: false,
  };
}

describe("FollowedViewWeapon", () => {
  let view: ReturnType<typeof makeView>;
  let followed: FollowedViewWeapon;

  beforeEach(() => {
    view = makeView();
    followed = new FollowedViewWeapon(() => view as unknown as WeaponViewManager);
  });

  it("shows the gun of a living player as we start watching, and hides a dead one's", () => {
    followed.follow("player_2");
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.clearFollowedBob).toHaveBeenCalled();

    followed.follow("player_3", true);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
  });

  it("leaves visibility to the caller when watching stops", () => {
    followed.follow("player_2");
    view.setVisible.mockClear();

    followed.follow(null);

    // A respawn is bringing our own gun back up at the same moment.
    expect(view.setVisible).not.toHaveBeenCalled();
    expect(followed.followedEntityId).toBeNull();
  });

  it("cuts on a seek even after the first weapon, and drops a switch in flight", () => {
    followed.follow("player_2");
    followed.showWeapon("machinegun");
    followed.showWeapon("riotgun", true);

    expect(view.cancelSwitch).toHaveBeenCalledTimes(2);
    expect(view.loadWeapon).toHaveBeenLastCalledWith("riotgun");
    expect(view.switchWeaponAnimated).not.toHaveBeenCalled();
  });

  it("does nothing while nobody is watched", () => {
    followed.showWeapon("machinegun");
    followed.fired();

    expect(view.loadWeapon).not.toHaveBeenCalled();
    expect(view.presentFire).not.toHaveBeenCalled();
  });

  it("flashes and kicks the gun when they fire, but not after they die", () => {
    followed.follow("player_2");
    followed.fired();
    expect(view.presentFire).toHaveBeenCalledTimes(1);

    followed.setDead(true);
    followed.fired();
    expect(view.presentFire).toHaveBeenCalledTimes(1);
  });

  it("hides the gun when they die and shows it when they come back, once per change", () => {
    followed.follow("player_2");
    view.setVisible.mockClear();

    followed.setDead(true);
    followed.setDead(true);
    followed.setDead(false);

    expect(view.setVisible.mock.calls).toEqual([[false], [true]]);
  });

  it("keeps a dead player's gun hidden through their weapon updates", () => {
    followed.follow("player_2", true);
    followed.showWeapon("machinegun");

    expect(view.setVisible).toHaveBeenLastCalledWith(false);
  });

  it("starts projectiles at the barrel only while their gun is up", () => {
    const at = { x: 0, y: 0, z: 0 } as never;
    followed.follow("player_2");
    expect(followed.muzzleFor(at, at)).toEqual({ x: 1, y: 2, z: 3 });

    followed.setDead(true);
    expect(followed.muzzleFor(at, at)).toBeNull();
  });

  it("sways the gun with their stride on the live clock", () => {
    followed.follow("player_2");
    followed.updateMotion(running(320), FollowedViewWeapon.liveClock(1000));
    const pose = followed.updateMotion(running(320), FollowedViewWeapon.liveClock(1016));

    expect(pose?.entityId).toBe("player_2");
    expect(pose?.demoDeltaSeconds).toBeCloseTo(0.016, 5);
    expect(pose?.horizontalSpeed).toBe(320);
    expect(view.updateFollowedBob).toHaveBeenLastCalledWith(
      expect.objectContaining({ deltaTime: pose?.demoDeltaSeconds, horizontalSpeed: 320, grounded: true }),
    );
    expect(followed.presentation).toBe(pose);
  });

  it("forgets the last stride when the watched player changes", () => {
    followed.follow("player_2");
    followed.updateMotion(running(320), FollowedViewWeapon.liveClock(1000));

    followed.follow("player_3");

    expect(followed.presentation).toBeNull();
    expect(followed.updateMotion(running(0), FollowedViewWeapon.liveClock(1016))?.demoDeltaSeconds).toBe(0);
  });

  it("waits for a view that is not built yet", () => {
    view.isReady = false;
    followed.follow("player_2");
    followed.showWeapon("machinegun");
    followed.fired();

    expect(view.setVisible).not.toHaveBeenCalled();
    expect(view.loadWeapon).not.toHaveBeenCalled();
    expect(view.presentFire).not.toHaveBeenCalled();
  });
});
