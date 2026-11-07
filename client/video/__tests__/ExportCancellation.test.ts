import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const engine = {
    getDeltaTime: () => 16,
    stopRenderLoop: vi.fn(),
    runRenderLoop: vi.fn(),
    setHardwareScalingLevel: vi.fn(),
    setSize: vi.fn(),
    dispose: vi.fn(),
  };
  const service = {
    loadRaw: vi.fn(async () => {}),
    loadAndPlayCinematic: vi.fn(async () => {}),
    waitForPlaybackModels: vi.fn(async () => {}),
    stopAll: vi.fn(),
    activeCinematicPlayer: { snapshotRecipe: () => ({ reel: { segments: [{}] } }) },
  };
  return { engine, service };
});
vi.mock("@babylonjs/core/Cameras/freeCamera", () => ({ FreeCamera: class {} }));
vi.mock("../../../../../engine/AudioManager", () => ({
  AudioManager: {
    getInstance: () => ({ setMusicEnabled: vi.fn(), setSfxEnabled: vi.fn(), ownSfxSink: () => vi.fn() }),
  },
}));
vi.mock("../../../../../engine/camera/CameraSystem", () => ({
  CameraSystem: { getInstance: () => ({ init: vi.fn(), setCamera: vi.fn(), dispose: vi.fn() }) },
}));
vi.mock("../../../../../engine/core/EngineServices", () => ({ registerEngineServices: vi.fn() }));
vi.mock("../../../../../engine/core/GamePaths", () => ({
  GamePaths: { getInstance: () => ({ initFromConfig: vi.fn() }) },
}));
vi.mock("../../../../../engine/core/ServiceLocator", () => ({
  ServiceLocator: { getInstance: () => ({ initCore: vi.fn(async () => {}), dispose: vi.fn() }) },
}));
vi.mock("../../../../../engine/loader/map/ClientMapLoader", () => ({ unloadClientMap: vi.fn() }));
vi.mock("../../../../../engine/loader/map/GameMapEntities", () => ({ registerGameMapEntities: vi.fn() }));
vi.mock("../../../../../engine/loader/pk3/PK3Index", () => ({
  PK3Index: { getInstance: () => ({ setSearchPaths: vi.fn(), ensureIndex: vi.fn(async () => {}) }) },
}));
vi.mock("../../../../../engine/runtime/BrowserRuntime", () => ({
  createBrowserRenderer: vi.fn(async () => ({ engine: state.engine, canvas: {} })),
  createBrowserScene: () => ({}),
  initializeBrowserScene: vi.fn(async () => {}),
}));
vi.mock("../../../../../engine/weapon/WeaponIdResolver", () => ({ registerWeaponIdResolver: vi.fn() }));
vi.mock("../../../world/FpsMapEntities", () => ({ fpsMapEntities: {} }));
vi.mock("../../../client/DemoService", () => ({ DemoService: { getInstance: () => state.service } }));
vi.mock("../../../client/TeleportEffect", () => ({
  TeleportEffect: { getInstance: () => ({ setPresentationClock: vi.fn() }) },
}));
vi.mock("../../../client/video/ExportAudioBuffers", () => ({
  ExportAudioBuffers: class {
    dispose() {}
  },
}));
vi.mock("../../../client/video/ExportSceneReadiness", () => ({
  ExportSceneReadiness: class {
    dispose() {}
  },
}));
vi.mock("../../../client/video/Mp4Writer", () => ({ Mp4Writer: { assertSupported: vi.fn(async () => {}) } }));

import { renderDemoMovie } from "../../../client/video/ExportRenderer";

describe("export font preparation cancellation", () => {
  it("releases the renderer on cancellation even if fonts never finish", async () => {
    let release!: () => void;
    const fonts = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(() => fonts);
    const world = { style: {}, addEventListener: vi.fn(), removeEventListener: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => world, body: { append: vi.fn() }, fonts: { load } });
    const controller = new AbortController();
    let settled = false;
    const job = renderDemoMovie(new Uint8Array([1]), { getContext: () => ({}) } as unknown as HTMLCanvasElement, {
      reelMinutes: 1,
      signal: controller.signal,
      progress: () => {},
    }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      controller.abort(new DOMException("Cancelled", "AbortError"));
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(state.engine.dispose).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await job;
      vi.unstubAllGlobals();
    }
    expect(state.engine.dispose).toHaveBeenCalledTimes(1);
  });
});
