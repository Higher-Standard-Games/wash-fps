import { Engine } from "@babylonjs/core/Engines/engine";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
// EngineInstrumentation needs the GPU frame-time counter (timeQuery) and, on
// WebGL, the timer-query implementation (engine.query); WebGPU bundles its own.
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.timeQuery";
import "@babylonjs/core/Engines/Extensions/engine.query";
import { EngineInstrumentation } from "@babylonjs/core/Instrumentation/engineInstrumentation";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { CameraSystem } from "../../../engine/camera/CameraSystem";
import type { FreeflyController } from "../../../engine/camera/controllers/FreeflyController";
import { Cvar } from "../../../engine/core/Cvar";
import { EngineVersion } from "../../../engine/core/EngineVersion";
import { observeRendererDevice } from "../../../engine/rendering/RendererDiagnostics";
import { getRenderingBackend } from "../../../engine/rendering/RenderingEngineFactory";
import { readTimedemoBundleCounters } from "../../../shared/benchmark/TimedemoBundles";
import {
  isFixtureId,
  sampleTimedemoCamera,
  segmentAt,
  selectTimedemoTarget,
  summarizeTimedemoSamples,
  type TimedemoFixture,
  type TimedemoSample,
  timedemoPercentiles,
  validateTimedemoFixture,
} from "../../../shared/benchmark/TimedemoFixture";
import { DemoReader } from "../../../shared/demo/DemoReader";
import { DemoService } from "./DemoService";
import { DemoViewer } from "./DemoViewer";

interface TimedemoRun {
  valid: boolean;
  reasons: string[];
  summary: ReturnType<typeof summarizeTimedemoSamples>;
  phases: Record<string, ReturnType<typeof summarizeTimedemoSamples>>;
  gpuSamplesMs: number[];
  gpuTiming: string;
  gpuMs: ReturnType<typeof timedemoPercentiles>;
  shaderCompiles: number;
  samples: TimedemoSample[];
  sceneReadiness: { before: boolean | null; after: boolean | null };
}

export interface TimedemoReport {
  schemaVersion: 1;
  status: "running" | "complete" | "failed" | "aborted";
  mode: "realtime";
  fixture?: TimedemoFixture;
  backend?: string;
  error?: string;
  createdAt: string;
  environment: Record<string, unknown>;
  runs: TimedemoRun[];
  limitations: string[];
}

const digest = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");

/** One bounded owner of playback + camera ordering. Normal demo RAF stays off. */
export class TimedemoService {
  private static instance: TimedemoService;
  static getInstance(): TimedemoService {
    if (!TimedemoService.instance) TimedemoService.instance = new TimedemoService();
    return TimedemoService.instance;
  }
  private controller: AbortController | null = null;
  report: TimedemoReport | null = null;
  progress = "idle";

  async list(): Promise<string[]> {
    const response = await fetch("/data/benchmarks/index.json");
    if (!response.ok) throw new Error("No benchmark catalogue. Run scripts/benchmarks/create-fixture.mjs first.");
    const ids: unknown = await response.json();
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !isFixtureId(id)))
      throw new Error("Invalid timedemo catalogue");
    return ids;
  }

  start(id: string, repeats = 3): string {
    if (this.controller) throw new Error("A timedemo is already running");
    if (!isFixtureId(id) || !Number.isInteger(repeats) || repeats < 1 || repeats > 5)
      throw new Error("Invalid fixture ID or repeats (1–5)");
    this.controller = new AbortController();
    this.report = {
      schemaVersion: 1,
      status: "running",
      mode: "realtime",
      createdAt: new Date().toISOString(),
      environment: {},
      runs: [],
      limitations: [
        "Refresh-paced real-time replay, not fixed-work throughput.",
        "GPU results are asynchronous fresh counter samples; they are not attributed to individual phases.",
        "Scene CPU excludes main-loop work before the benchmark hook; playback CPU is reported separately.",
        "Generated route clearance and visual coverage require browser acceptance.",
        "Bundle totals cover the whole engine frame (world, gun and enabled auxiliary passes), not individual actors.",
        "Full-scene readiness is checked outside measurement; per-frame pending-data counts do not establish shader readiness.",
      ],
    };
    const signal = this.controller.signal;
    void this.run(id, repeats, signal);
    return `Timedemo loading ${id} (${repeats} repetitions). Close the console during warmup; timedemo report/export show results. Escape or timedemo abort stops it.`;
  }

  abort(): void {
    this.controller?.abort();
  }

  private publish(): void {
    (window as unknown as { timedemoReport: TimedemoReport | null }).timedemoReport = this.report;
    console.log("TIMEDEMO_REPORT", this.report);
  }

  private async run(id: string, repeats: number, signal: AbortSignal): Promise<void> {
    const service = DemoService.getInstance();
    const cameras = CameraSystem.getInstance();
    const scene = cameras.getCamera()?.getScene();
    const engine = scene?.getEngine();
    let owned = false;
    let size: { width: number; height: number } | null = null;
    const previouslyEnabled = new Map<string, boolean>();
    try {
      if (!scene || !engine) throw new Error("No active browser scene");
      this.progress = "loading fixture";
      const response = await fetch(`/data/benchmarks/${id}/manifest.json`, { signal });
      if (!response.ok) throw new Error(`Fixture not found: ${id}`);
      const fixture = validateTimedemoFixture(await response.json());
      if (fixture.id !== id) throw new Error("Fixture identity mismatch");
      const demoResponse = await fetch(`/data/benchmarks/${id}/${fixture.demo.file}`, { signal });
      if (!demoResponse.ok) throw new Error("Recording unavailable; regenerate the fixture");
      const bytes = new Uint8Array(await demoResponse.arrayBuffer());
      if ((await digest(bytes)) !== fixture.demo.sha256) throw new Error("Recording hash mismatch");
      const reader = await DemoReader.fromFile(bytes);
      const header = reader.readHeader();
      const index = reader.readIndex();
      const firstTick = index.entries[0]?.tick;
      const lastTick = index.entries[index.entries.length - 1]?.tick;
      if (
        header.map !== fixture.demo.map ||
        header.version !== fixture.demo.version ||
        header.tickRate !== fixture.demo.tickRate ||
        header.players.length !== fixture.demo.players ||
        (lastTick - firstTick) / header.tickRate < fixture.startSeconds + fixture.durationSeconds
      )
        throw new Error("Fixture recording metadata/interval changed; regenerate it");
      const backend = getRenderingBackend(engine);
      const requested = new URLSearchParams(location.search).get("renderer");
      if (
        backend === "null" ||
        backend === "webgl1" ||
        (["webgpu", "webgl2"].includes(requested ?? "") && backend !== requested)
      )
        throw new Error(`Benchmark requires actual requested GPU backend; got ${backend}`);
      for (const [name, value] of Object.entries(fixture.profile.requiredCvars)) {
        if (Number(Cvar.get(name)) !== value)
          throw new Error(
            `Profile requires ${name} ${value}. Set it explicitly, then rerun; timedemo does not persist quality overrides.`,
          );
      }
      if (!this.report) throw new Error("Missing report");
      this.report.fixture = fixture;
      this.report.backend = backend;
      this.report.environment = {
        browser: navigator.userAgent,
        babylonVersion: Engine.Version,
        engineClass: engine.constructor.name,
        shagVersion: EngineVersion.getInstance().getVersion(),
        buildLabel: new URLSearchParams(location.search).get("benchmarkLabel") ?? "unlabelled workspace build",
        webgpuCompatibilityMode: backend === "webgpu" ? engine.compatibilityMode : null,
        viewport: [window.innerWidth, window.innerHeight],
        devicePixelRatio: window.devicePixelRatio,
        profile: fixture.profile,
        cvars: Object.fromEntries(
          Cvar.getNames()
            .filter((name) => /^(r_|cl_)/.test(name))
            .map((name) => [name, Cvar.get(name)]),
        ),
        capabilities: { timerQuery: !!engine.getCaps().timerQuery, maxTextureSize: engine.getCaps().maxTextureSize },
      };
      size = { width: engine.getRenderWidth(), height: engine.getRenderHeight() };
      engine.setSize(fixture.profile.width, fixture.profile.height);
      for (let repetition = 0; repetition < repeats; repetition++) {
        for (const warmup of [true, false]) {
          signal.throwIfAborted();
          this.progress = `${warmup ? "warmup" : "measure"} ${repetition + 1}/${repeats}`;
          owned = true;
          await service.loadRaw(bytes, id);
          const viewer = new DemoViewer();
          await this.bounded(service.loadAndPlayNormal(viewer, { manual: true }), signal, 120000);
          signal.throwIfAborted();
          for (const type of ["freefly", "spectator"]) {
            const controller = cameras.getController(type);
            if (controller) {
              if (!previouslyEnabled.has(type)) previouslyEnabled.set(type, controller.isEnabled());
              controller.setEnabled(false);
            }
          }
          await this.bounded(service.waitForPlaybackModels(), signal, 30000);
          const run = await this.play(scene, fixture, viewer, firstTick, warmup, signal);
          if (!warmup) this.report.runs.push(run);
          service.stopAll();
        }
      }
      this.report.status = "complete";
    } catch (error) {
      if (this.report) {
        this.report.status = signal.aborted ? "aborted" : "failed";
        this.report.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (owned) service.stopAll();
      for (const [type, enabled] of previouslyEnabled) cameras.getController(type)?.setEnabled(enabled);
      if (size && engine && !scene?.isDisposed) engine.setSize(size.width, size.height);
      this.controller = null;
      this.progress = this.report?.status ?? "failed";
      this.publish();
      console.log(this.formatReport());
    }
  }

  private bounded<T>(promise: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Timedemo preparation timed out")), ms);
      const aborted = () => finish(new Error("Timedemo aborted"));
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve(value as T);
      };
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      promise.then((value) => finish(undefined, value), finish);
    });
  }

  private play(
    scene: Scene,
    fixture: TimedemoFixture,
    viewer: DemoViewer,
    firstTick: number,
    warmup: boolean,
    signal: AbortSignal,
  ): Promise<TimedemoRun> {
    const service = DemoService.getInstance();
    const cameras = CameraSystem.getInstance();
    const engine = scene.getEngine();
    // Full Scene.isReady prepares effects for every mesh, including hidden ones.
    // Calling it after each measured render was both expensive and intrusive.
    const readSceneReadiness = () => {
      try {
        return scene.isReady();
      } catch {
        return null;
      }
    };
    const readinessBefore = readSceneReadiness();
    const sceneStats = new SceneInstrumentation(scene);
    const engineStats = new EngineInstrumentation(engine);
    engineStats.captureShaderCompilationTime = true;
    engineStats.captureGPUFrameTime = true;
    const samples: TimedemoSample[] = [];
    const gpuSamplesMs: number[] = [];
    let gpuCount = engineStats.gpuFrameTimeCounter.count;
    let last = performance.now();
    let frameAtMs = last;
    let frameStart = last;
    let playbackCpuMs = 0;
    let wallMs = 0;
    let seconds = -fixture.startSeconds;
    let target: string | null = null;
    let measured = false;
    let shaderCompileBaseline = 0;
    let startedMeasurement = false;
    let stopped = false;
    const collectBundles = engine.isWebGPU && engine.compatibilityMode === false;
    let pendingBundleSample: TimedemoSample | null = null;
    let finishAfterEndFrame = false;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timeout);
        scene.onBeforeAnimationsObservable.remove(before);
        scene.onAfterRenderObservable.remove(after);
        scene.onDisposeObservable.remove(disposed);
        if (endFrame) engine.onEndFrameObservable.remove(endFrame);
        signal.removeEventListener("abort", aborted);
        document.removeEventListener("visibilitychange", visibility);
        window.removeEventListener("keydown", keyboard);
        unobserve();
        engineStats.captureGPUFrameTime = false;
        engineStats.dispose();
        sceneStats.dispose();
        if (error) {
          reject(error);
          return;
        }
        const reasons: string[] = [];
        if (!samples.length && !warmup) reasons.push("No measured frames");
        if (!warmup && seconds < fixture.durationSeconds)
          reasons.push("Recording ended before the measured interval completed");
        if (samples.some((s) => s.skippedFrames > 0))
          reasons.push("Playback skipped recorded frames/events after a stall");
        if (samples.some((s) => s.alivePlayers > s.loadedBodies))
          reasons.push("Some living player bodies were not loaded");
        if (collectBundles && samples.some((s) => s.bundles === null))
          reasons.push("WebGPU NCM bundle counters were unavailable for some measured engine frames");
        if (
          samples.some(
            (s) => fixture.segments.find((p) => p.name === s.phase)?.camera === "spectator" && !s.spectatorTarget,
          )
        )
          reasons.push("No living saved spectator target");
        const phases = Object.fromEntries(
          fixture.segments.map((s) => [
            s.name,
            summarizeTimedemoSamples(samples.filter((sample) => sample.phase === s.name)),
          ]),
        );
        if (!warmup) {
          for (const segment of fixture.segments) {
            const phaseSamples = samples.filter((s) => s.phase === segment.name);
            if (!phaseSamples.length) reasons.push(`Missing phase: ${segment.name}`);
            if (segment.camera === "spectator" && phaseSamples.length && !phaseSamples.some((s) => s.povWeaponLoaded))
              reasons.push(`No loaded first-person gun in phase: ${segment.name}`);
          }
        }
        resolve({
          valid: !reasons.length,
          reasons,
          summary: summarizeTimedemoSamples(samples),
          phases,
          samples,
          sceneReadiness: { before: readinessBefore, after: readSceneReadiness() },
          gpuSamplesMs,
          gpuMs: timedemoPercentiles(gpuSamplesMs),
          gpuTiming: gpuSamplesMs.length
            ? "Fresh asynchronous counter samples (ms), unassigned to phases"
            : "unavailable",
          shaderCompiles: Math.max(0, engineStats.shaderCompilationTimeCounter.count - shaderCompileBaseline),
        });
      };
      const aborted = () => finish(new Error("Timedemo aborted"));
      const visibility = () => {
        if (document.hidden) finish(new Error("Benchmark tab became hidden"));
      };
      const keyboard = (event: KeyboardEvent) => {
        if (event.key === "Escape" || measured) finish(new Error("Benchmark interrupted by keyboard input"));
      };
      const unobserve = observeRendererDevice(engine, (error) => finish(new Error(`Renderer error: ${String(error)}`)));
      const timeout = setTimeout(
        () => finish(new Error("Timedemo render loop timed out")),
        (fixture.startSeconds + fixture.durationSeconds + 60) * 1000,
      );
      const disposed = scene.onDisposeObservable.add(() => finish(new Error("Benchmark scene disposed")));
      // Scene.onAfterRender is too early: countersLastFrame still belongs to the
      // preceding frame. WebGPUEngine.endFrame copies the counters before this hook.
      const endFrame = collectBundles
        ? engine.onEndFrameObservable.add(() => {
            if (stopped || !pendingBundleSample) return;
            pendingBundleSample.bundles = readTimedemoBundleCounters((engine as WebGPUEngine).countersLastFrame);
            pendingBundleSample = null;
            if (finishAfterEndFrame) finish();
          })
        : null;
      const before = scene.onBeforeAnimationsObservable.add(() => {
        try {
          if (pendingBundleSample)
            throw new Error(
              "Measured scene rendered again before engine end-of-frame; bundle attribution is ambiguous",
            );
          if (signal.aborted || service.activeDemoViewer !== viewer)
            throw new Error("Timedemo playback was replaced or aborted");
          if (
            document.hidden ||
            engine.getRenderWidth() !== fixture.profile.width ||
            engine.getRenderHeight() !== fixture.profile.height
          )
            throw new Error("Benchmark visibility or render dimensions changed");
          for (const [name, value] of Object.entries(fixture.profile.requiredCvars))
            if (Number(Cvar.get(name)) !== value) throw new Error(`Benchmark profile changed: ${name}`);
          const now = performance.now();
          frameAtMs = now;
          wallMs = now - last;
          last = now;
          const updateStart = now;
          service.updatePlaybackFrame(wallMs, () => {
            seconds = (viewer.getInfo().playheadTick - firstTick) / fixture.demo.tickRate - fixture.startSeconds;
            const segment = segmentAt(fixture, Math.max(0, seconds));
            if (segment.camera === "spectator") {
              const state = service.getPlaybackState();
              target = selectTimedemoTarget(segment.targets ?? [], state);
              service.setPlaybackSpectatorTarget(target);
              const controller = cameras.getController("spectator");
              controller?.setEnabled(true);
              controller?.update(wallMs / 1000);
              controller?.setEnabled(false);
            } else {
              target = null;
              service.setPlaybackSpectatorTarget(null);
              if (cameras.getActiveController()?.type !== "freefly") cameras.setController("freefly");
              cameras.getController("freefly")?.setEnabled(false);
              const pose = sampleTimedemoCamera(segment, Math.max(0, seconds));
              const controller = cameras.getController("freefly") as FreeflyController;
              controller.setPosition(new Vector3(pose.position.x, pose.position.y, pose.position.z));
              const camera = controller.getCamera();
              if (!camera) throw new Error("Freefly camera missing");
              const dx = pose.lookAt.x - pose.position.x,
                dy = pose.lookAt.y - pose.position.y,
                dz = pose.lookAt.z - pose.position.z;
              camera.rotation.set(-Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0);
            }
            const camera = scene.activeCamera;
            if (camera) {
              camera.fov = (fixture.profile.fov * Math.PI) / 180;
              camera.getViewMatrix(true);
              camera.getProjectionMatrix(true);
            }
          });
          playbackCpuMs = performance.now() - updateStart;
          measured = !warmup && seconds >= 0 && seconds < fixture.durationSeconds;
          if (measured && !startedMeasurement) {
            startedMeasurement = true;
            shaderCompileBaseline = engineStats.shaderCompilationTimeCounter.count;
          }
          frameStart = performance.now();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const after = scene.onAfterRenderObservable.add(() => {
        if (stopped) return;
        if (measured) {
          const bodies = service.getPlaybackModelStats();
          const sample: TimedemoSample = {
            seconds,
            phase: segmentAt(fixture, seconds).name,
            wallMs,
            frameAtMs,
            playbackCpuMs,
            sceneCpuMs: performance.now() - frameStart,
            animationMs: sceneStats.animationsTimeCounter.current,
            drawCalls: sceneStats.drawCallsCounter.current,
            triangles: Math.floor(scene.getActiveIndices() / 3),
            activeMeshes: scene.getActiveMeshes().length,
            ...bodies,
            spectatorTarget: target,
            povWeaponLoaded: service.isPlaybackWeaponLoaded(),
            sceneReady: null,
            pendingSceneData: scene.getWaitingItemsCount(),
            skippedFrames: viewer.getInfo().skippedFrames,
            bundles: null,
          };
          samples.push(sample);
          if (collectBundles) pendingBundleSample = sample;
          const gpu = engineStats.gpuFrameTimeCounter;
          if (gpu.count !== gpuCount) {
            gpuCount = gpu.count;
            if (gpu.current > 0) gpuSamplesMs.push(gpu.current / 1e6);
          }
          if (samples.length > 50000) {
            finish(new Error("Benchmark sample limit exceeded"));
            return;
          }
        }
        if (seconds >= fixture.durationSeconds || viewer.getState() === "ended") {
          if (pendingBundleSample) finishAfterEndFrame = true;
          else finish();
        }
      });
      // Register after playback's before-animations hook: otherwise Babylon's
      // animation counter would include our snapshot/camera update time.
      sceneStats.captureAnimationsTime = true;
      signal.addEventListener("abort", aborted, { once: true });
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener("keydown", keyboard);
    });
  }

  formatReport(): string {
    const report = this.report;
    if (!report) return "No timedemo report";
    const lines = [
      `Timedemo ${report.status}: ${report.fixture?.id ?? "loading"}; backend ${report.backend ?? "unknown"}; mode realtime`,
      `Progress: ${this.progress}`,
    ];
    if (report.error) lines.push(report.error);
    report.runs.forEach((run, i) => {
      lines.push(
        `Run ${i + 1}: ${run.valid ? "valid" : "INVALID"}; ${run.summary.frames} frames; wall p50/p95/p99 ${run.summary.wallMs.p50?.toFixed(2)}/${run.summary.wallMs.p95?.toFixed(2)}/${run.summary.wallMs.p99?.toFixed(2)} ms; >${run.summary.frameBudgetMs.toFixed(2)}ms ${run.summary.overBudgetPercent?.toFixed(1)}%`,
      );
      for (const [name, phase] of Object.entries(run.phases)) {
        lines.push(
          `  ${name}: ${phase.frames} frames; scene CPU p95 ${phase.sceneCpuMs.p95?.toFixed(2)}ms; playback CPU p95 ${phase.playbackCpuMs.p95?.toFixed(2)}ms; draws p95 ${phase.drawCalls.p95?.toFixed(0)}`,
        );
        if (phase.bundles) {
          const b = phase.bundles;
          lines.push(
            `    bundles: ${b.created} created / ${b.reused} reused; per frame ${b.createdPerFrame.toFixed(1)} created / ${b.reusedPerFrame.toFixed(1)} reused; creation share ${b.creationSharePercent?.toFixed(1) ?? "n/a"}%; frames creating ${b.framesWithCreationPercent.toFixed(1)}%; coverage ${b.sampledFrames}/${b.sampledFrames + b.missingFrames}`,
          );
        }
      }
      if (!run.summary.bundles)
        lines.push("  Bundle counters: not applicable or unavailable (see backend/compatibility metadata)");
      if (run.reasons.length) lines.push(`  ${run.reasons.join("; ")}`);
      lines.push(
        `  GPU: ${run.gpuTiming}; fresh samples ${run.gpuSamplesMs.length}; p50/p95/p99 ${run.gpuMs.p50?.toFixed(2) ?? "n/a"}/${run.gpuMs.p95?.toFixed(2) ?? "n/a"}/${run.gpuMs.p99?.toFixed(2) ?? "n/a"}ms; shader compiles ${run.shaderCompiles}`,
      );
    });
    return lines.join("\n");
  }

  export(): string {
    if (!this.report) return "No timedemo report";
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `timedemo-${this.report.fixture?.id ?? "failed"}-${this.report.backend ?? "unknown"}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return "Timedemo JSON exported (raw samples included)";
  }
}
