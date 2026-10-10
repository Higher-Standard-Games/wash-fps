// @vitest-environment jsdom
import { Observable } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimedemoFixture } from "../../../../shared/benchmark/TimedemoFixture";
import type { DemoViewer } from "../DemoViewer";

const h = vi.hoisted(() => ({
  gpu: { count: 0, current: 0 },
  disposed: vi.fn(),
  deviceUnsubscribe: vi.fn(),
  deviceFailure: null as null | ((error: unknown) => void),
  service: {
    activeDemoViewer: null as unknown,
    updatePlaybackFrame: vi.fn(),
    setPlaybackSpectatorTarget: vi.fn(),
    getPlaybackState: () => ({ entities: new Map([["player_1", {}]]), events: [] }),
    getPlaybackModelStats: vi.fn(() => ({ alivePlayers: 1, loadedBodies: 1 })),
    isPlaybackWeaponLoaded: vi.fn(() => true),
  },
  cameras: { getController: vi.fn(), getActiveController: () => ({ type: "freefly" }), setController: vi.fn() },
}));
vi.mock("../DemoService", () => ({ DemoService: { getInstance: () => h.service } }));
vi.mock("../../../../engine/camera/CameraSystem", () => ({ CameraSystem: { getInstance: () => h.cameras } }));
vi.mock("../../../../engine/core/EngineVersion", () => ({ EngineVersion: {} }));
vi.mock("../../../../engine/rendering/RendererDiagnostics", () => ({
  observeRendererDevice: (_engine: unknown, callback: (error: unknown) => void) => {
    h.deviceFailure = callback;
    return h.deviceUnsubscribe;
  },
}));
vi.mock("@babylonjs/core/Instrumentation/engineInstrumentation", () => ({
  EngineInstrumentation: class {
    gpuFrameTimeCounter = h.gpu;
    shaderCompilationTimeCounter = { count: 0 };
    captureGPUFrameTime = false;
    captureShaderCompilationTime = false;
    dispose() {
      h.disposed("engine");
    }
  },
}));
vi.mock("@babylonjs/core/Instrumentation/sceneInstrumentation", () => ({
  SceneInstrumentation: class {
    animationsTimeCounter = { current: 1 };
    drawCallsCounter = { current: 12 };
    captureAnimationsTime = false;
    dispose() {
      h.disposed("scene");
    }
  },
}));

import { type TimedemoReport, TimedemoService } from "../TimedemoService";

const fixture: TimedemoFixture = {
  schemaVersion: 1,
  id: "test",
  demo: { file: "demo.shagdemo", sha256: "a".repeat(64), map: "wdm2", players: 1, tickRate: 100, version: 3 },
  startSeconds: 0,
  durationSeconds: 2,
  seed: 1,
  profile: { width: 1280, height: 720, fov: 90, requiredCvars: {} },
  provenance: {},
  segments: [
    {
      name: "tour",
      start: 0,
      end: 1,
      camera: "freefly",
      keyframes: [
        { tick: 0, position: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 1 } },
        { tick: 1, position: { x: 1, y: 0, z: 0 }, lookAt: { x: 1, y: 0, z: 1 } },
      ],
    },
    { name: "gun", start: 1, end: 2, camera: "spectator", targets: ["player_1"] },
  ],
};
function setup(ncm = false) {
  const camera = { rotation: { set: vi.fn() }, getViewMatrix: vi.fn(), getProjectionMatrix: vi.fn(), fov: 0 };
  const freefly = { setEnabled: vi.fn(), setPosition: vi.fn(), getCamera: () => camera };
  const spectator = { setEnabled: vi.fn(), update: vi.fn() };
  h.cameras.getController.mockImplementation((type) => (type === "spectator" ? spectator : freefly));
  let seconds = 0,
    skippedFrames = 0;
  const viewer = { getInfo: () => ({ playheadTick: 100 + seconds * 100, skippedFrames }), getState: () => "playing" };
  const order: string[] = [];
  h.service.activeDemoViewer = viewer;
  h.service.updatePlaybackFrame.mockImplementation((_dt, callback) => {
    order.push("playback");
    callback();
  });
  const engine = {
    getRenderWidth: () => 1280,
    getRenderHeight: () => 720,
    isWebGPU: ncm,
    compatibilityMode: !ncm,
    countersLastFrame: { numBundleCreationNonCompatMode: 999, numBundleReuseNonCompatMode: 999 },
    onEndFrameObservable: new Observable(),
  };
  const scene = {
    getEngine: () => engine,
    activeCamera: camera,
    onBeforeAnimationsObservable: new Observable(),
    onAfterRenderObservable: new Observable(),
    onDisposeObservable: new Observable(),
    getActiveIndices: () => 300,
    getActiveMeshes: () => ({ length: 4 }),
    isReady: vi.fn(() => true),
    getWaitingItemsCount: vi.fn(() => 0),
  };
  const frame = (time: number, skips = 0, bundles = { created: 0, reused: 0 }, endFrame = true) => {
    seconds = time;
    skippedFrames = skips;
    scene.onBeforeAnimationsObservable.notifyObservers({});
    order.push("render");
    scene.onAfterRenderObservable.notifyObservers({});
    if (endFrame) {
      engine.countersLastFrame.numBundleCreationNonCompatMode = bundles.created;
      engine.countersLastFrame.numBundleReuseNonCompatMode = bundles.reused;
      engine.onEndFrameObservable.notifyObservers({});
    }
  };
  const signal = new AbortController();
  const service = TimedemoService.getInstance();
  const play = (warmup = false) =>
    (
      service as unknown as {
        play(...args: unknown[]): Promise<TimedemoReport["runs"][number]>;
      }
    ).play(scene as unknown as Scene, fixture, viewer as unknown as DemoViewer, 100, warmup, signal.signal);
  return {
    play,
    frame,
    signal,
    order,
    spectator,
    engine,
    scene,
    dispose: () => scene.onDisposeObservable.notifyObservers({}),
  };
}
describe("manual timedemo render ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.gpu.count = 0;
    h.gpu.current = 0;
    h.service.getPlaybackModelStats.mockReturnValue({ alivePlayers: 1, loadedBodies: 1 });
    h.service.isPlaybackWeaponLoaded.mockReturnValue(true);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });
  it("anchors manual playback at the first hook instead of counting preparation wait as playback", async () => {
    let now = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const s = setup();
    try {
      const result = s.play();
      now = 1100; // A full second before any manual playback update.
      s.frame(0.5);
      expect(h.service.updatePlaybackFrame.mock.calls[0][0]).toBe(0);
      now = 1116;
      s.frame(1.5);
      expect(h.service.updatePlaybackFrame.mock.calls[1][0]).toBe(16);
      now = 1124;
      s.frame(2);
      expect((await result).valid).toBe(true);
    } finally {
      s.signal.abort();
      clock.mockRestore();
    }
  });
  it("still forwards a real stall after clock startup and rejects its skipped events", async () => {
    let now = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const s = setup();
    try {
      const result = s.play();
      now = 1100;
      s.frame(0.5);
      now = 1811;
      s.frame(1.5, 27);
      expect(h.service.updatePlaybackFrame.mock.calls[1][0]).toBe(711);
      now = 1820;
      s.frame(2, 27);
      expect((await result).reasons).toContain("Playback skipped recorded frames/events after a stall");
    } finally {
      s.signal.abort();
      clock.mockRestore();
    }
  });
  it("keeps full-scene readiness outside measured renders and timestamps wall intervals", async () => {
    const s = setup();
    const result = s.play();
    expect(s.scene.isReady).toHaveBeenCalledTimes(1);
    s.scene.getWaitingItemsCount.mockReturnValue(2);
    s.frame(0.5);
    s.scene.getWaitingItemsCount.mockReturnValue(0);
    s.frame(1.5);
    expect(s.scene.isReady).toHaveBeenCalledTimes(1);
    s.frame(2);
    const run = await result;
    expect(s.scene.isReady).toHaveBeenCalledTimes(2);
    expect(run.sceneReadiness).toEqual({ before: true, after: true });
    expect(run.samples.map((sample) => sample.sceneReady)).toEqual([null, null]);
    expect(run.summary.sceneReadinessObservedFrames).toBe(0);
    expect(run.summary.unreadySceneFrames).toBe(0);
    expect(run.summary.pendingSceneDataFrames).toBe(1);
    expect(run.samples[1].frameAtMs! - run.samples[0].frameAtMs!).toBe(run.samples[1].wallMs);
  });
  it("updates playback before rendering, cuts to a bot, and counts only fresh GPU results", async () => {
    const s = setup();
    const result = s.play();
    s.frame(0.5);
    h.gpu.count = 1;
    h.gpu.current = 2e6;
    s.frame(1.1);
    s.frame(1.5);
    s.frame(2);
    const run = await result;
    expect(run.valid).toBe(true);
    expect(run.samples).toHaveLength(3);
    expect(run.gpuSamplesMs).toEqual([2]);
    expect(s.order).toEqual(["playback", "render", "playback", "render", "playback", "render", "playback", "render"]);
    expect(h.service.setPlaybackSpectatorTarget).toHaveBeenCalledWith("player_1");
    expect(s.spectator.update).toHaveBeenCalledTimes(3);
    expect(h.disposed).toHaveBeenCalledTimes(2);
    expect(h.deviceUnsubscribe).toHaveBeenCalledOnce();
  });
  it("marks event skipping invalid instead of returning a deceptively faster score", async () => {
    const s = setup();
    const result = s.play();
    s.frame(0.5, 10);
    s.frame(1.5, 10);
    s.frame(2, 10);
    expect((await result).reasons).toContain("Playback skipped recorded frames/events after a stall");
  });
  it("does not collect warmup samples", async () => {
    const s = setup();
    const result = s.play(true);
    s.frame(0.5);
    s.frame(1.5);
    s.frame(2);
    expect((await result).samples).toEqual([]);
  });
  it("attaches fresh end-of-frame bundle totals to the correct phase, excluding pre-roll and warmup", async () => {
    const s = setup(true);
    const result = s.play();
    s.frame(-0.1, 0, { created: 100, reused: 100 });
    s.frame(0.5, 0, { created: 2, reused: 8 });
    s.frame(1.1, 0, { created: 7, reused: 3 });
    s.frame(1.5, 0, { created: 0, reused: 5 });
    s.frame(2, 0, { created: 200, reused: 200 });
    const run = await result;
    expect(run.valid).toBe(true);
    expect(run.samples.map((sample) => [sample.phase, sample.bundles])).toEqual([
      ["tour", { created: 2, reused: 8 }],
      ["gun", { created: 7, reused: 3 }],
      ["gun", { created: 0, reused: 5 }],
    ]);
    expect(s.engine.onEndFrameObservable.hasObservers()).toBe(false);
    const service = TimedemoService.getInstance();
    service.report = {
      schemaVersion: 1,
      status: "complete",
      mode: "realtime",
      fixture,
      backend: "webgpu",
      createdAt: "2026-10-09",
      environment: {},
      limitations: [],
      runs: [run],
    };
    expect(service.formatReport()).toContain("creation share 20.0%");
    expect(service.formatReport()).toContain("per frame 2.0 created / 8.0 reused");
    const warm = setup(true);
    const warmResult = warm.play(true);
    warm.frame(0.5, 0, { created: 99, reused: 99 });
    warm.frame(2);
    expect((await warmResult).samples).toEqual([]);
  });
  it("rejects ambiguous phase attribution when two measured scene renders share an engine frame", async () => {
    const s = setup(true);
    const result = s.play();
    const rejected = expect(result).rejects.toThrow("before engine end-of-frame");
    s.frame(0.5, 0, { created: 0, reused: 0 }, false);
    s.frame(1.1);
    await rejected;
    expect(s.engine.onEndFrameObservable.hasObservers()).toBe(false);
  });
  it("removes the engine end-of-frame hook after cancellation", async () => {
    const s = setup(true);
    const result = s.play();
    const rejected = expect(result).rejects.toThrow("aborted");
    s.frame(0.5);
    s.signal.abort();
    await rejected;
    expect(s.engine.onEndFrameObservable.hasObservers()).toBe(false);
  });
  it("keeps unavailable NCM counters null and invalidates incomplete counter coverage", async () => {
    const s = setup(true);
    const result = s.play();
    s.frame(0.5, 0, { created: NaN, reused: 1 });
    s.frame(1.5);
    s.frame(2);
    const run = await result;
    expect(run.samples[0].bundles).toBeNull();
    expect(run.valid).toBe(false);
    expect(run.reasons).toContain("WebGPU NCM bundle counters were unavailable for some measured engine frames");
  });
  it("does not label WebGPU compatibility-mode work as zero NCM submissions", async () => {
    const s = setup(true);
    s.engine.compatibilityMode = true;
    const result = s.play();
    s.frame(0.5);
    s.frame(1.5);
    s.frame(2);
    const run = await result;
    expect(run.valid).toBe(true);
    expect(run.samples.every((sample) => sample.bundles === null)).toBe(true);
  });
  it("rejects missing bodies and gunless POV coverage", async () => {
    h.service.getPlaybackModelStats.mockReturnValue({ alivePlayers: 10, loadedBodies: 0 });
    h.service.isPlaybackWeaponLoaded.mockReturnValue(false);
    const s = setup();
    const result = s.play();
    s.frame(0.5);
    s.frame(1.5);
    s.frame(2);
    const run = await result;
    expect(run.valid).toBe(false);
    expect(run.reasons).toContain("Some living player bodies were not loaded");
    expect(run.reasons).toContain("No loaded first-person gun in phase: gun");
  });
  it("times out and releases hooks if rendering never starts", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const result = s.play();
      const rejected = expect(result).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(62001);
      await rejected;
      expect(h.disposed).toHaveBeenCalledTimes(2);
      expect(h.deviceUnsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["abort", "hidden", "device", "keyboard", "replacement", "dispose"])("cleans up after %s", async (cause) => {
    const s = setup();
    const result = s.play();
    const rejected = expect(result).rejects.toThrow();
    s.frame(0.5);
    if (cause === "abort") s.signal.abort();
    if (cause === "hidden") {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }
    if (cause === "device") h.deviceFailure?.("device lost");
    if (cause === "keyboard") window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));
    if (cause === "replacement") {
      h.service.activeDemoViewer = null;
      s.frame(1.5);
    }
    if (cause === "dispose") s.dispose();
    await rejected;
    const before = h.service.updatePlaybackFrame.mock.calls.length;
    s.frame(1.5);
    expect(h.service.updatePlaybackFrame.mock.calls.length).toBe(before);
    expect(h.disposed).toHaveBeenCalledTimes(2);
    expect(h.deviceUnsubscribe).toHaveBeenCalledOnce();
  });
});
