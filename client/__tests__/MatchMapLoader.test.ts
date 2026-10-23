import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MatchMapLoader runs when the server names its map. These tests pin the order
 * and the failure handling it inherited from Game.initializeNetwork: the loading
 * curtain is held before the load and always released, a failed load shuts the
 * connection down, prediction gets the collision world and trigger volumes, the
 * camera starts in freefly, and watch/auto-join start afterwards.
 */

const calls: string[] = [];
let mapResult: unknown = "ok";
let collisionReady = true;
let weaponLoading: Promise<void> | null = null;
let weaponError: Error | null = null;
let bsp: { entities: unknown[]; models: unknown[] } | null = { entities: [], models: [] };
const controllers = new Map<string, unknown>();
const scene = { name: "scene" };

vi.mock("../../../../engine/ui/MapLoadingOverlay", () => ({
  MapLoadingOverlay: {
    hold: (key: string) => calls.push(`hold:${key}`),
    release: (key: string) => calls.push(`release:${key}`),
  },
}));
vi.mock("../../../../engine/loader/map/ClientMapLoader", () => ({
  loadClientMap: async (map: string) => {
    calls.push(`load:${map}`);
    if (mapResult instanceof Error) throw mapResult;
    return mapResult;
  },
}));
vi.mock("../FPSAudio", () => ({ preloadFPSAudio: async () => calls.push("audio") }));
vi.mock("../FPSWeaponPreloader", () => ({
  preloadFPSWeapons: async () => {
    calls.push("weapons");
    if (weaponError) throw weaponError;
    await weaponLoading;
  },
}));
vi.mock("../../../../engine/physics/CollisionManager", () => ({
  getCollisionManager: () => ({ isInitialized: () => collisionReady, getBsp: () => bsp }),
}));
vi.mock("../../simulation/collision/BSPCollisionWorld", () => ({
  createBSPCollisionWorld: () => ({ world: true }),
}));
vi.mock("../../../../shared/bsp/TriggerTable", () => ({
  extractTriggerVolumes: () => ["volume"],
}));
vi.mock("../TeleportEffect", () => ({
  TeleportEffect: { getInstance: () => ({ prewarm: () => calls.push("prewarm"), localTeleported: vi.fn() }) },
}));
vi.mock("../../../../engine/camera/CameraSystem", () => ({
  CameraSystem: {
    getInstance: () => ({
      getCamera: () => ({ getScene: () => scene }),
      getFreeCamera: () => ({ getScene: () => scene }),
      getController: (name: string) => controllers.get(name),
      registerController: (name: string, controller: unknown) => {
        calls.push(`register:${name}`);
        controllers.set(name, controller);
      },
      setController: (name: string) => calls.push(`camera:${name}`),
    }),
  },
}));
vi.mock("../../camera/FPSController", () => ({ FPSController: class {} }));
vi.mock("../../../../engine/camera/controllers/FreeflyController", () => ({ FreeflyController: class {} }));

const { MatchMapLoader } = await import("../MatchMapLoader");

function host(over: { aliveCount?: number; v2?: boolean } = {}) {
  const v2Client = {
    setTriggerVolumes: vi.fn((volumes: unknown) => calls.push(`triggers:${String(volumes)}`)),
    onTeleport: vi.fn(),
  };
  return {
    v2: v2Client,
    shutdown: vi.fn(() => calls.push("shutdown")),
    setCollisionWorld: vi.fn(() => calls.push("collision")),
    startUnderwaterView: vi.fn(() => calls.push("underwater")),
    v2Client: () => (over.v2 === false ? null : (v2Client as never)),
    spectatorCycling: () => ({ getAliveCount: () => over.aliveCount ?? 0 }),
    nextSpectateTarget: vi.fn(),
    joinGame: vi.fn(),
  };
}

/** Let the fire-and-forget dynamic imports inside the loader settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("MatchMapLoader", () => {
  beforeEach(() => {
    calls.length = 0;
    mapResult = "ok";
    collisionReady = true;
    weaponLoading = null;
    weaponError = null;
    bsp = { entities: [], models: [] };
    controllers.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("holds the curtain, loads, sets up prediction and cameras, then releases the curtain", async () => {
    const h = host();
    await new MatchMapLoader(h, {}).onServerInfo({ map: "wdm7" });
    await settle();

    expect(calls.slice(0, 4)).toEqual(["hold:fps:postload", "load:wdm7", "audio", "collision"]);
    expect(calls).toContain("triggers:volume");
    expect(h.v2.onTeleport).toHaveBeenCalledTimes(1);
    expect(calls).toContain("underwater");
    expect(calls).toContain("prewarm");
    const release = calls.indexOf("release:fps:postload");
    expect(calls).toContain("weapons");
    expect(calls.indexOf("register:fps")).toBeLessThan(release);
    expect(calls.indexOf("register:freefly")).toBeLessThan(release);
    expect(calls.indexOf("camera:freefly")).toBeLessThan(release);
    expect(calls.indexOf("weapons")).toBeGreaterThan(calls.indexOf("camera:freefly"));
    expect(calls.indexOf("weapons")).toBeLessThan(release);
    expect(h.shutdown).not.toHaveBeenCalled();
  });

  it("loads the map once however many times the server says hello", async () => {
    const loader = new MatchMapLoader(host(), {});
    await loader.onServerInfo({ map: "wdm7" });
    await loader.onServerInfo({ map: "wdm7" });
    expect(calls.filter((c) => c.startsWith("load:"))).toHaveLength(1);
  });

  it("does not release the screen or auto-join until held weapons are prepared", async () => {
    let ready!: () => void;
    weaponLoading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const pending = new MatchMapLoader(host(), {}).onServerInfo({ map: "wdm7" });
    await vi.waitFor(() => expect(calls).toContain("weapons"));
    expect(calls).not.toContain("release:fps:postload");
    ready();
    await pending;
    expect(calls.at(-1)).toBe("release:fps:postload");
  });

  it("disconnects and releases the screen if held weapon preparation fails", async () => {
    weaponError = new Error("missing weapon");
    const h = host();
    await new MatchMapLoader(h, { autoJoin: true }).onServerInfo({ map: "wdm7" });
    expect(h.shutdown).toHaveBeenCalledOnce();
    expect(h.joinGame).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe("release:fps:postload");
  });

  it("shuts down and still releases the curtain when the map load reports failure", async () => {
    mapResult = "Failed to load wdm99";
    const h = host();
    await new MatchMapLoader(h, {}).onServerInfo({ map: "wdm99" });
    expect(h.shutdown).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("audio");
    expect(calls.at(-1)).toBe("release:fps:postload");
  });

  it("shuts down and still releases the curtain when the map load throws", async () => {
    mapResult = new Error("network");
    const h = host();
    await new MatchMapLoader(h, {}).onServerInfo({ map: "wdm7" });
    expect(h.shutdown).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toBe("release:fps:postload");
  });

  it("skips collision and triggers without a collision manager, but still sets up cameras", async () => {
    collisionReady = false;
    const h = host();
    await new MatchMapLoader(h, {}).onServerInfo({ map: "wdm7" });
    expect(h.setCollisionWorld).not.toHaveBeenCalled();
    expect(h.v2.setTriggerVolumes).not.toHaveBeenCalled();
    expect(calls).toContain("camera:freefly");
  });

  it("keeps existing camera controllers rather than registering new ones", async () => {
    controllers.set("fps", { existing: true });
    controllers.set("freefly", { existing: true });
    await new MatchMapLoader(host(), {}).onServerInfo({ map: "wdm7" });
    expect(calls.filter((c) => c.startsWith("register:"))).toEqual([]);
  });

  it("auto-joins 200 ms after the map is ready", async () => {
    vi.useFakeTimers();
    const h = host();
    await new MatchMapLoader(h, { autoJoin: true }).onServerInfo({ map: "wdm7" });
    expect(h.joinGame).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(h.joinGame).toHaveBeenCalledTimes(1);
  });

  it("in watch mode, chases the first player once someone is alive, and gives up after 30 s", async () => {
    vi.useFakeTimers();
    let alive = 0;
    const h = { ...host(), spectatorCycling: () => ({ getAliveCount: () => alive }) };
    await new MatchMapLoader(h, { watchOnly: true }).onServerInfo({ map: "wdm7" });
    vi.advanceTimersByTime(1000);
    expect(h.nextSpectateTarget).not.toHaveBeenCalled();
    alive = 1;
    vi.advanceTimersByTime(200);
    expect(h.nextSpectateTarget).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(h.nextSpectateTarget).toHaveBeenCalledTimes(1);

    const late = { ...host(), spectatorCycling: () => ({ getAliveCount: () => alive }) };
    alive = 0;
    await new MatchMapLoader(late, { watchOnly: true }).onServerInfo({ map: "wdm7" });
    vi.advanceTimersByTime(30_000);
    alive = 1;
    vi.advanceTimersByTime(1000);
    expect(late.nextSpectateTarget).not.toHaveBeenCalled();
  });
});
