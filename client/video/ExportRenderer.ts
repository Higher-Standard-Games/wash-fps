import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Collisions/collisionCoordinator";
import "@babylonjs/loaders/glTF";
import { AudioManager } from "../../../../engine/AudioManager";
import { CameraSystem } from "../../../../engine/camera/CameraSystem";
import { registerEngineServices } from "../../../../engine/core/EngineServices";
import { GamePaths } from "../../../../engine/core/GamePaths";
import { ownPresentationClock } from "../../../../engine/core/PresentationTime";
import { ServiceLocator } from "../../../../engine/core/ServiceLocator";
import { unloadClientMap } from "../../../../engine/loader/map/ClientMapLoader";
import { registerGameMapEntities } from "../../../../engine/loader/map/GameMapEntities";
import { PK3Index } from "../../../../engine/loader/pk3/PK3Index";
import {
  createBrowserRenderer,
  createBrowserScene,
  initializeBrowserScene,
} from "../../../../engine/runtime/BrowserRuntime";
import { registerWeaponIdResolver } from "../../../../engine/weapon/WeaponIdResolver";
import browserConfig from "../../browser.json";
import { isClientKey } from "../../ClientEntityKey";
import gameJson from "../../game.json";
import { canonicalWeaponId } from "../../shared/entities/definitions/weapons/WeaponsTable";
import { fpsMapEntities } from "../../world/FpsMapEntities";
import { DemoService } from "../DemoService";
import { DemoViewer } from "../DemoViewer";
import { TeleportEffect } from "../TeleportEffect";
import { assertAudioAgreement, assertAudioMovieRates } from "./ExportAudioAgreement";
import { ExportAudioBuffers } from "./ExportAudioBuffers";
import { ExportAudioCapture } from "./ExportAudioCapture";
import { mixExportAudio } from "./ExportAudioMixer";
import { type PreparedExportMusic, prepareExportMusic } from "./ExportMusic";
import type { ExportMusicSelection } from "./ExportMusicSelection";
import { drawReelOverlay } from "./ExportOverlay";
import { ExportSceneReadiness } from "./ExportSceneReadiness";
import { abortable, MOVIE_FPS, renderMovieFrames } from "./MovieClock";
import { Mp4Writer } from "./Mp4Writer";
import { assertReelMovieFrame, collectReelMovieSchedule, type ReelMovieFrame } from "./ReelMovieSchedule";
import { warmShot } from "./ShotPreroll";
import type { TemporaryVideo } from "./TemporaryVideo";

let servicesRegistered = false;

export interface ExportMovieOptions {
  signal: AbortSignal;
  progress: (phase: string, frames?: number, total?: number) => void;
  /** Internal proof fixture only; public exports select highlight reels. */
  fromSeconds?: number;
  stallMs?: number;
  reelMinutes?: 1 | 2 | 3;
  music?: ExportMusicSelection;
}

/** Export-owned playback and rendering in a separate document. */
export async function renderDemoMovie(
  bytes: Uint8Array,
  canvas: HTMLCanvasElement,
  options: ExportMovieOptions,
): Promise<TemporaryVideo> {
  const { progress } = options;
  const job = new AbortController();
  const signal = job.signal;
  const cancelJob = () => job.abort(options.signal.reason);
  options.signal.addEventListener("abort", cancelJob, { once: true });
  if (options.signal.aborted) cancelJob();
  const world = document.createElement("canvas");
  world.style.cssText = "position:fixed;left:-10000px;width:1920px;height:1080px";
  canvas.width = options.reelMinutes ? 1920 : 1280;
  canvas.height = options.reelMinutes ? 1080 : 720;
  const composed = canvas.getContext("2d", { alpha: false });
  if (!composed) {
    options.signal.removeEventListener("abort", cancelJob);
    throw new Error("The export compositor is unavailable");
  }
  const clock = { nowMs: 0, deltaMs: 0 };
  const effectClock = { nowMs: 0 };
  const releaseClock = ownPresentationClock(clock);
  document.body.append(world);
  const contextLost = (event: Event) => {
    event.preventDefault();
    job.abort(new Error("The graphics context was lost. Try exporting again."));
  };
  world.addEventListener("webglcontextlost", contextLost);
  const deadline = setTimeout(() => job.abort(new Error("Video export exceeded its twenty-minute limit")), 20 * 60_000);
  const minimumAnimationDelta = Scene.MinDeltaTime;
  Scene.MinDeltaTime = 0;
  const service = DemoService.getInstance();
  const cameras = CameraSystem.getInstance();
  let engine: Awaited<ReturnType<typeof createBrowserRenderer>>["engine"] | undefined;
  let writer: Mp4Writer | undefined;
  let readiness: ExportSceneReadiness | undefined;
  let soundBuffers: ExportAudioBuffers | undefined;
  let preparedMusic: PreparedExportMusic | undefined;
  let capture: ExportAudioCapture | undefined;
  let releaseSoundSink: (() => void) | undefined;
  let succeeded = false;
  let exported: TemporaryVideo | undefined;
  let failed = false;
  let jobError: unknown;
  const cleanupErrors: unknown[] = [];
  let restoreDelta: (() => void) | undefined;
  const timer = setTimeout(() => preparation.abort(new Error("Video preparation timed out")), 180_000);
  const preparation = new AbortController();
  const cancel = () => preparation.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    await abortable(Mp4Writer.assertSupported(canvas.width, canvas.height, !!options.reelMinutes), preparation.signal);
    progress("Preparing renderer");
    GamePaths.getInstance().initFromConfig(browserConfig.engine, gameJson.displayName);
    if (!servicesRegistered) {
      registerEngineServices();
      servicesRegistered = true;
    }
    registerGameMapEntities(fpsMapEntities);
    registerWeaponIdResolver(canonicalWeaponId);
    await ServiceLocator.getInstance().initCore();
    const renderer = await createBrowserRenderer(world, "?renderer=webgl2");
    engine = renderer.engine;
    const getDelta = engine.getDeltaTime;
    engine.getDeltaTime = () => clock.deltaMs;
    restoreDelta = () => {
      if (engine) engine.getDeltaTime = getDelta;
    };
    const scene = createBrowserScene(engine);
    readiness = new ExportSceneReadiness(scene, clock);
    const camera = new FreeCamera("exportCamera", new Vector3(0, 50, 0), scene);
    camera.minZ = 1;
    camera.maxZ = 10000;
    camera.updateUpVectorFromRotation = true;
    cameras.init(scene, renderer.canvas);
    cameras.setCamera(camera);
    await initializeBrowserScene(scene, progress);
    const audio = AudioManager.getInstance();
    audio.setMusicEnabled(false);
    audio.setSfxEnabled(false);
    if (options.reelMinutes) {
      soundBuffers = new ExportAudioBuffers(signal);
      capture = new ExportAudioCapture((paths, settings) => soundBuffers!.preload(paths, settings));
      releaseSoundSink = audio.ownSfxSink(capture);
    }
    const index = PK3Index.getInstance();
    index.setSearchPaths(["data/"]);
    await abortable(index.ensureIndex(progress), preparation.signal);
    if (options.music) {
      if (!options.reelMinutes) throw new Error("Music is supported for highlight exports.");
      progress("Preparing selected OST song");
      preparedMusic = await prepareExportMusic({ ...options.music }, preparation.signal);
    }
    engine.setHardwareScalingLevel(1);
    engine.setSize(canvas.width, canvas.height);
    // Preparation may await GPU warm-up. This owner is stopped before movie work.
    engine.runRenderLoop(() => scene.render());
    await abortable(service.loadRaw(bytes, "video-export-fixture"), preparation.signal);
    const viewer = new DemoViewer();
    if (options.reelMinutes)
      await abortable(
        service.loadAndPlayCinematic(viewer, cameras, options.reelMinutes, { manual: true }),
        preparation.signal,
      );
    else await abortable(service.loadAndPlayNormal(viewer, { manual: true }), preparation.signal);
    await abortable(service.waitForPlaybackModels(), preparation.signal);
    const first = viewer.getInfo();
    const fromSeconds = options.fromSeconds ?? 0;
    if (
      !options.reelMinutes &&
      (!Number.isFinite(fromSeconds) || fromSeconds < 0 || first.durationMs < (fromSeconds + 10) * 1000)
    )
      throw new Error("The proof requires ten recorded seconds after its start");
    engine.stopRenderLoop();
    if (options.reelMinutes) TeleportEffect.getInstance().setPresentationClock(() => effectClock.nowMs);
    clearTimeout(timer);
    preparation.signal.throwIfAborted();
    const settleWeapon = async () => {
      await abortable(service.waitForPlaybackEffects(), signal);
      await abortable(service.waitForPlaybackWeapon(), signal);
    };
    const preroll = async (leadIn?: number) => {
      const movieTime = capture ? capture.nowMs / 1000 : 0;
      const rate = viewer.getSpeed();
      let rollback: (() => void) | undefined;
      const used = await warmShot(
        service,
        viewer,
        signal,
        async (dt, remaining) => {
          const time = movieTime - Math.max(0, remaining - dt) / 1000 / rate;
          capture?.setTime(time, rate);
          effectClock.nowMs = time * 1000;
          clock.deltaMs = dt;
          service.updatePlaybackFrame(dt, undefined, { preroll: true });
          await settleWeapon();
          engine!.beginFrame();
          await readiness!.render(signal);
          engine!.endFrame();
        },
        () => {
          TeleportEffect.getInstance().clear();
          if (rollback) rollback();
          else rollback = capture?.checkpoint();
        },
        leadIn === undefined ? undefined : [leadIn],
      );
      capture?.setTime(movieTime, rate);
      effectClock.nowMs = clock.nowMs;
      await settleWeapon();
      return used;
    };
    const reelFrame = (): ReelMovieFrame => {
      const player = service.activeCinematicPlayer;
      if (!player) throw new Error("The export reel was replaced");
      const playback = service.activeDemoViewer!.getInfo();
      return {
        sourceTick: playback.playheadTick,
        segment: player.getReelInfo().currentSegment,
        speed: playback.playbackSpeed,
        title: player.isShowingTitle(),
        ended: player.getState() === "ended",
      };
    };
    if (options.reelMinutes) {
      const recipe = service.activeCinematicPlayer!.snapshotRecipe();
      if (!recipe.reel.segments.length) throw new Error("This demo has no highlights to export");
      await abortable(
        Promise.all([document.fonts.load("700 52px Orbitron"), document.fonts.load("500 30px Rajdhani")]),
        signal,
      );
      engine.setSize(320, 180);
      const bindAudio = () => {
        const player = service.activeCinematicPlayer!;
        player.onBeforeSegment((segment) => capture!.cut(capture!.nowMs / 1000, segment.segmentIndex));
        player.onReelEnd(() => capture!.cut(capture!.nowMs / 1000, recipe.reel.totalSegments));
      };
      const sampleListener = () => {
        capture!.setTime(capture!.nowMs / 1000, viewer.getSpeed());
        const view = scene.activeCameras?.[0] ?? scene.activeCamera;
        if (!view) throw new Error("The export has no listening camera");
        view.getViewMatrix(true);
        capture!.sampleListener({
          position: view.globalPosition,
          forward: view.getDirection(new Vector3(0, 0, -1)),
          up: view.getDirection(Vector3.Up()),
        });
      };
      capture!.begin();
      bindAudio();
      let warmed = -1;
      const leadIns = new Map<number, number>();
      const schedule = await collectReelMovieSchedule(async (dt, index) => {
        capture!.setTime(index / MOVIE_FPS, viewer.getSpeed());
        clock.deltaMs = dt;
        clock.nowMs += dt;
        effectClock.nowMs = clock.nowMs;
        service.updatePlaybackFrame(dt);
        const frame = reelFrame();
        if (!frame.title && !frame.ended && frame.segment !== warmed) {
          capture!.cut(index / MOVIE_FPS, frame.segment);
          leadIns.set(frame.segment, await preroll());
          warmed = frame.segment;
        }
        await settleWeapon();
        clock.deltaMs = dt;
        engine!.beginFrame();
        await readiness!.render(signal);
        sampleListener();
        engine!.endFrame();
        if (index % 60 === 0) progress("Preparing the exact reel timeline", index);
        return reelFrame();
      }, signal);
      if (viewer.getInfo().skippedFrames) throw new Error("Reel preparation skipped recorded events");
      const audioPlan = capture!.snapshot(schedule.length / MOVIE_FPS);
      assertAudioMovieRates(audioPlan, schedule);
      progress("Mixing game audio offline");
      const mixed = await mixExportAudio(
        audioPlan,
        (path, settings) => soundBuffers!.get(path, settings),
        signal,
        preparedMusic,
      );
      preparedMusic = undefined;
      service.stopAll();
      releaseSoundSink!();
      capture = new ExportAudioCapture((paths, settings) => soundBuffers!.preload(paths, settings));
      releaseSoundSink = audio.ownSfxSink(capture);
      clock.nowMs = 0;
      clock.deltaMs = 0;
      engine.setSize(canvas.width, canvas.height);
      engine.runRenderLoop(() => scene.render());
      await abortable(
        service.loadAndPlayCinematic(viewer, cameras, options.reelMinutes, { manual: true, recipe }),
        signal,
      );
      await abortable(service.waitForPlaybackModels(), signal);
      engine.stopRenderLoop();
      TeleportEffect.getInstance().setPresentationClock(() => effectClock.nowMs);
      capture.begin();
      bindAudio();
      writer = await Mp4Writer.create(canvas, schedule.length / MOVIE_FPS, signal, mixed.buffer);
      const activeWriter = writer;
      warmed = -1;
      await renderMovieFrames(schedule.length, signal, async (frame) => {
        capture!.setTime(frame.index / MOVIE_FPS, viewer.getSpeed());
        // Copy the final picture before end-of-frame invalidates the drawing buffer.
        clock.deltaMs = frame.index === 0 ? 0 : 1000 / MOVIE_FPS;
        clock.nowMs += clock.deltaMs;
        effectClock.nowMs = clock.nowMs;
        service.updatePlaybackFrame(clock.deltaMs);
        const state = reelFrame();
        if (!state.title && !state.ended && state.segment !== warmed) {
          capture!.cut(frame.index / MOVIE_FPS, state.segment);
          const leadIn = leadIns.get(state.segment);
          if (leadIn === undefined) throw new Error("The frozen shot has no preparation schedule");
          await preroll(leadIn);
          warmed = state.segment;
        }
        await settleWeapon();
        clock.deltaMs = frame.index === 0 ? 0 : 1000 / MOVIE_FPS;
        engine!.beginFrame();
        await readiness!.render(signal);
        sampleListener();
        assertReelMovieFrame(schedule[frame.index], reelFrame(), frame.index);
        const missing = service.getUnresolvedPlaybackProjectiles();
        if (!state.title && !state.ended && missing.length)
          throw new Error(`A movie frame is missing projectile spawn data: ${missing.join(", ")}`);
        composed.drawImage(renderer.canvas, 0, 0, canvas.width, canvas.height);
        drawReelOverlay(composed, service.activeCinematicPlayer!, recipe);
        engine!.endFrame();
        await activeWriter.add(frame);
        progress("Rendering highlight video", frame.index + 1, schedule.length);
        if (frame.index % 4 === 0 || options.stallMs)
          await abortable(new Promise<void>((resolve) => setTimeout(resolve, options.stallMs ?? 0)), signal);
      });
      if (viewer.getInfo().skippedFrames) throw new Error("Reel rendering skipped recorded events");
      assertAudioAgreement(audioPlan, capture.snapshot(schedule.length / MOVIE_FPS));
      progress("Finalizing MP4");
      const result = await writer.finish();
      succeeded = true;
      exported = result;
    } else {
      // One boundary seek, then sequential pre-roll and frame delivery.
      const preRoll = Math.min(2, fromSeconds);
      const rate = first.header!.tickRate;
      viewer.seekToTick(first.playheadTick + (fromSeconds - preRoll) * rate);
      viewer.play();
      const target = [...(service.getPlaybackState()?.entities.keys() ?? [])].find(isClientKey);
      if (!target) throw new Error("No recorded player is available at the clip start");
      service.setPlaybackSpectatorTarget(target);
      for (let i = 0; i < Math.round(preRoll * MOVIE_FPS); i++) {
        signal.throwIfAborted();
        clock.deltaMs = 1000 / MOVIE_FPS;
        clock.nowMs += clock.deltaMs;
        service.updatePlaybackFrame(clock.deltaMs);
        engine.beginFrame();
        await readiness.render(signal);
        engine.endFrame();
      }
      writer = await Mp4Writer.create(canvas, 10, signal);
      const activeEngine = engine;
      const activeWriter = writer;
      await renderMovieFrames(600, signal, async (frame) => {
        clock.deltaMs = frame.index === 0 ? 0 : 1000 / MOVIE_FPS;
        clock.nowMs += clock.deltaMs;
        service.updatePlaybackFrame(clock.deltaMs);
        activeEngine.beginFrame();
        await readiness!.render(signal);
        composed.drawImage(renderer.canvas, 0, 0, canvas.width, canvas.height);
        activeEngine.endFrame();
        await activeWriter.add(frame);
        progress("Rendering silent integration clip", frame.index + 1, 600);
        if (frame.index % 4 === 0 || options.stallMs)
          await abortable(new Promise<void>((resolve) => setTimeout(resolve, options.stallMs ?? 0)), signal);
      });
      if (viewer.getInfo().skippedFrames !== 0) throw new Error("The demo skipped recorded frames during export");
      progress("Finalizing MP4");
      const result = await writer.finish();
      succeeded = true;
      exported = result;
    }
  } catch (error) {
    failed = true;
    jobError = error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(timer);
    preparation.abort();
    signal.removeEventListener("abort", cancel);
    options.signal.removeEventListener("abort", cancelJob);
    world.removeEventListener("webglcontextlost", contextLost);
    const cleanup: Array<() => void | Promise<void>> = [
      () => engine?.stopRenderLoop(),
      () => readiness?.dispose(),
      () => TeleportEffect.getInstance().setPresentationClock(null),
      () => service.stopAll(),
      () => releaseSoundSink?.(),
      () => soundBuffers?.dispose(),
      () => {
        preparedMusic = undefined;
      },
      async () => {
        if (writer && !succeeded) await writer.dispose();
      },
      () => unloadClientMap(),
      () => cameras.dispose(),
      () => ServiceLocator.getInstance().dispose(),
      () => restoreDelta?.(),
      () => engine?.dispose(),
      () => releaseClock(),
      () => {
        Scene.MinDeltaTime = minimumAnimationDelta;
      },
      () => world.remove(),
    ];
    for (const dispose of cleanup) {
      try {
        await dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    service.loadedDemoData = null;
    service.loadedDemoReader = null;
  }
  if (failed) {
    if (cleanupErrors.length) console.warn("Video cleanup diagnostics:", ...cleanupErrors);
    throw jobError;
  }
  if (cleanupErrors.length) {
    await exported?.dispose();
    throw new Error(`Video session cleanup failed: ${cleanupErrors.map(String).join("; ")}`);
  }
  if (!exported) throw new Error("No completed video");
  return exported;
}
