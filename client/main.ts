/**
 * Washoi browser application entry point
 *
 * Owns startup presentation, engine composition, lobby and gameplay lifecycle.
 */

import { devLog } from "../../../engine/core/DevLog";
import "../../../style.css";
import "../../../engine/ui/styles/WashikiFonts.css"; // Washiki fonts available at startup (before HUD)

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";
// Side-effect import for Babylon native collision (used by FreeflyController)
import "@babylonjs/core/Collisions/collisionCoordinator";
import { CameraSystem } from "../../../engine/camera";
import { registerEngineCommands } from "../../../engine/console/commands";
import { QualityDetector, registerEngineServices, ServiceLocator } from "../../../engine/core";
import { logRejection } from "../../../engine/core/AsyncErrors";
import { CapacitorBridge } from "../../../engine/core/CapacitorBridge";
import { Cvar } from "../../../engine/core/Cvar";
import { EngineVersion } from "../../../engine/core/EngineVersion";
import { GamePaths } from "../../../engine/core/GamePaths";
import type { LoadingProgressEvent, LoadingStartEvent } from "../../../engine/core/LoadingEvents";
import { DebugConsole } from "../../../engine/debug";
import { BrowserEditorHost } from "../../../engine/editor/BrowserEditorHost";
import { PLAYTEST_RETURN_KEY, registerEditorLauncher } from "../../../engine/editor/EditorLauncher";
import { PK3Index } from "../../../engine/loader/pk3/PK3Index";
import {
  installRendererRuntimeDiagnostics,
  type RendererRuntimeReport,
} from "../../../engine/rendering/RendererRuntimeDiagnostics";
import type { ActualRenderingBackend } from "../../../engine/rendering/RenderingEngineFactory";
import {
  createBrowserRenderer,
  createBrowserScene,
  initializeBrowserScene,
} from "../../../engine/runtime/BrowserRuntime";
import { configureLobbyTwin } from "../../../engine/ui/components/LobbyTwin";
import { LoadingScreen } from "../../../engine/ui/LoadingScreen";
import { MapLoadingOverlay } from "../../../engine/ui/MapLoadingOverlay";
import { installStaleBuildNotice } from "../../../engine/ui/StaleBuildNotice";
import { TransferLoadingView } from "../../../engine/ui/TransferLoadingView";
import { UIScale } from "../../../engine/ui/UIScale";
import { UITheme } from "../../../engine/ui/UITheme";
import browserConfig from "../browser.json";
import { FPSController } from "../camera/FPSController";
import { FPSPlayer } from "../FPSPlayer";
import gameJson from "../game.json";
import { FrameRateDisplay } from "./hud/FrameRateDisplay";
import { LobbyPanel } from "./LobbyPanel";
import { registerWashoiServices } from "./registerServices";

/** How long past the player's click the start-up screen waits for the lobby to log them in */
const LOBBY_ANSWER_WAIT_MS = 4000;

interface DebugWindow extends Window {
  __lobbyPanel?: LobbyPanel;
  engine?: AbstractEngine;
  player?: FPSPlayer;
  rendererBackend?: ActualRenderingBackend;
  rendererRuntimeReport?: RendererRuntimeReport;
  scene?: Scene;
}

/**
 * Main application entry point.
 */
async function main() {
  const debugWindow = window as DebugWindow;
  if (new URLSearchParams(window.location.search).get("rendererqa") === "1") {
    const { runRendererQA } = await import("../../../engine/rendering/RendererQA");
    await runRendererQA(document.getElementById("renderCanvas") as HTMLCanvasElement, window.location.search);
    return;
  }

  // Show progress before any asynchronous initialization can fail.
  configureLobbyTwin({
    brand: { logo: "/data/washoi.png", name: "WASHIKI WASHOI" },
  });
  const loadingScreen = new LoadingScreen();
  loadingScreen.show();
  loadingScreen.setStatus("Initializing engine...", "initialization");

  // Platform classes, mobile CSS and the native lifecycle, before anything
  // draws. No-ops in a browser beyond the touch-device class.
  const capacitor = CapacitorBridge.getInstance();
  await capacitor.init();

  // Initialize GamePaths
  GamePaths.getInstance().initFromConfig(browserConfig.engine, gameJson.displayName);

  // Set browser title
  EngineVersion.getInstance().setDocumentTitle();

  // A lazy chunk missing after a deploy offers a reload
  installStaleBuildNotice();

  // Register engine services
  registerEngineServices();

  // Initialize core services
  await ServiceLocator.getInstance().initCore();

  // Auto-detect quality
  const qualityRecommendation = QualityDetector.getInstance().detectQuality();
  devLog(`[Main] Device: ${qualityRecommendation.deviceInfo.type}, Quality: ${qualityRecommendation.quality}`);

  let canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

  // Show startup feedback before async WebGPU initialization or WebGL fallback.
  // The start-up, handoff and map loading screens are the lobby's twin, so they
  // wear the game's logo where the lobby does.
  loadingScreen.setStatus("Initializing renderer...", "renderer");

  // The native splash is configured not to hide itself, so it waits for this.
  // Now is the moment: our own loading screen is up and showing progress, and
  // holding the splash any longer would hide that progress behind a still
  // image. No-op off a device.
  void capacitor.hideSplashScreen();

  const renderer = await createBrowserRenderer(canvas, window.location.search);
  canvas = renderer.canvas;
  const engine = renderer.engine;
  if (renderer.fallbackReason) {
    console.warn(`[Main] ${renderer.fallbackReason}; using ${renderer.backend}`);
  }
  devLog(
    `[Main] Rendering backend: ${renderer.backend}${renderer.nonCompatibilityMode ? " (non-compatibility mode)" : ""}`,
  );
  const rendererDiagnostics = installRendererRuntimeDiagnostics(engine, (report) => {
    debugWindow.rendererRuntimeReport = report;
    console.error(`RENDERER_RUNTIME_REPORT ${JSON.stringify({ ...report, errors: report.errors.slice(-1) })}`);
  });

  // Handle window resize
  window.addEventListener("resize", () => engine.resize());

  // Build PK3 index
  const pk3Index = PK3Index.getInstance();
  pk3Index.setSearchPaths(["data/"]);
  loadingScreen.setStep("packages");
  await pk3Index.ensureIndex((msg) => loadingScreen.setStatus(msg));
  loadingScreen.setStep("engine");

  // Initialize debug console
  const debugConsole = DebugConsole.getInstance();
  debugConsole.enable();

  // Register engine commands, then fps-specific commands (connect, disconnect, demo*, netsim)
  // and register the fps NetworkConnector so the engine's lobby ConnectingOverlay can
  // initiate a connection without importing fps directly.
  await registerEngineCommands();
  await registerWashoiServices();

  // Initialize UI
  UIScale.getInstance().init();
  const uiTheme = UITheme.getInstance();
  await uiTheme.loadShareTechMonoFont();

  // Start waiting for user click (non-blocking — runs in parallel)
  const userReadyPromise = loadingScreen.waitForReady();

  // Pipe map loading progress into the splash screen
  const { EventBus } = await import("../../../engine/core/EventBus");
  const unsubProgress = EventBus.on("loading:progress", (data: LoadingProgressEvent | undefined) => {
    if (data?.type === "map" && data?.phase) {
      loadingScreen.setStatus(data.detail || data.phase);
    }
  });

  // ── Engine initialization (runs while user is looking at splash screen) ──

  // Create scene
  devLog("[Main] Creating scene...");
  const scene = createBrowserScene(engine);
  const frameRateDisplay = new FrameRateDisplay(() => engine.getFps());
  scene.onDisposeObservable.addOnce(() => frameRateDisplay.destroy());

  // Create FPS camera
  const camera = new FreeCamera("fpsCamera", new Vector3(0, 50, 0), scene);
  // The view's roll goes through its up vector; rebuild it from the rotation
  // every frame, or a roll that stops changing leaves the view tilted.
  camera.updateUpVectorFromRotation = true;
  camera.attachControl(canvas, true);
  camera.minZ = 1.0; // Match EngineScene default to prevent depth issues
  camera.maxZ = 10000;
  scene.activeCamera = camera;
  scene.autoClear = true; // Ensure buffer clearing matches EngineScene

  await initializeBrowserScene(scene, (status) => loadingScreen.setStatus(status));

  // Initialize camera system
  const cameraSystem = CameraSystem.getInstance();
  cameraSystem.init(scene, canvas);
  cameraSystem.setCamera(camera); // CRITICAL: Register the camera we created
  cameraSystem.registerController("fps", new FPSController());
  cameraSystem.setController("fps");
  const controller = cameraSystem.getController("fps") as FPSController;

  devLog("[Main] FPS controller initialized");

  // Initialize FPSPlayer (Game Logic)
  const player = new FPSPlayer(controller);
  devLog("[Main] FPSPlayer initialized");

  // ── Lobby (no 3D background — will use background image in future) ──
  // Every map is played on a server the lobby spawns; the client loads it on join.
  // The lobby is built behind the start-up screen: it connects and logs in
  // while the player is still looking at it, so it appears knowing who they
  // are, and a new player sees the name screen at once instead of the lobby
  // for a moment first. A lobby slow to answer is not waited on for long.
  loadingScreen.setStep("lobby");
  loadingScreen.setStatus("Connecting to the lobby...");
  const lobby = new LobbyPanel();
  await Promise.race([lobby.connected, new Promise((resolve) => setTimeout(resolve, LOBBY_ANSWER_WAIT_MS))]);
  // Everything is loaded: the bar fills and the start button comes up (a
  // player who clicked early goes straight on)
  loadingScreen.markReady();
  await userReadyPromise;

  // Stop piping progress to splash screen
  unsubProgress();

  // Enable overlay for future map loads (e.g., joining a match), in the look of
  // the match handoff that comes before it
  MapLoadingOverlay.configure({ view: () => new TransferLoadingView() });
  MapLoadingOverlay.enable();

  // Hide splash → show lobby: the player has clicked, and the lobby has answered
  loadingScreen.hide();
  lobby.show();
  lobby.initialLoadingDismissed();

  // Connect play button (Phase 1: just log; Phase 2+: real matchmaking)
  lobby.setOnPlay((mode) => {
    devLog(`[Lobby] Queue for mode: ${mode}`);
  });

  // Store lobby reference for gameplay map transitions
  debugWindow.__lobbyPanel = lobby;

  // Hide lobby when a GAMEPLAY map starts loading (network connect, console map cmd, etc.)
  // Uses loading:start (not map:loaded) so it fires IMMEDIATELY, not after map finishes.
  import("../../../engine/core/EventBus")
    .then(({ EventBus }) => {
      EventBus.on("loading:start", (data: LoadingStartEvent | undefined) => {
        if (data?.type !== "map") return;
        // Don't hide for background ui map
        if (data?.id === "ui") return;

        const lobby = debugWindow.__lobbyPanel;
        if (lobby?.isVisible()) {
          lobby.hide();
          devLog(`[Main] Lobby hidden (map loading: ${data?.id})`);
        }
      });
    })
    .catch(logRejection("main"));

  const editorHost = new BrowserEditorHost(
    engine,
    canvas,
    () => lobby.isVisible(),
    () => {
      const wasEnabled = controller.isEnabled();
      const wasLobbyVisible = lobby.isVisible();
      controller.setEnabled(false);
      camera.detachControl();
      if (document.pointerLockElement) void document.exitPointerLock();
      if (wasLobbyVisible) lobby.hide();
      // Leave the console's own open/closed state alone: it stays usable
      // while editing (~ still toggles it), so a mapper mid-command when
      // they open the editor isn't met with it vanishing out from under them.
      return () => {
        camera.attachControl(canvas, true);
        controller.setEnabled(wasEnabled);
        if (wasLobbyVisible) lobby.show();
      };
    },
    () => lobby.show(),
  );
  registerEditorLauncher(editorHost);
  if (sessionStorage.getItem(PLAYTEST_RETURN_KEY)) {
    sessionStorage.removeItem(PLAYTEST_RETURN_KEY);
    try {
      if (Cvar.getBool("developer")) await editorHost.open();
    } catch (error) {
      console.error("Could not restore SHAGGED after Playtest:", error);
    }
  }

  // Start render loop
  engine.runRenderLoop(() => {
    try {
      const deltaTime = engine.getDeltaTime() / 1000.0;

      if (!editorHost.renderEditor()) {
        player.update(deltaTime);
        scene.render();
      }
    } catch (error) {
      rendererDiagnostics.recordRenderError(error);
      throw error;
    }
  });

  // Expose for debug
  debugWindow.scene = scene;
  debugWindow.engine = engine;
  debugWindow.rendererBackend = renderer.backend;
  debugWindow.player = player;

  devLog('[Main] FPS mode ready. Press ~ for console, use "map <name>" to load maps.');
}

// showPlaceholderUI replaced by LobbyPanel (see above)

main().catch((error) => {
  console.error(error);
  LoadingScreen.failBoot(error);
});
