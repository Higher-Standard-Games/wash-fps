/**
 * The lobby alone, as the native Washoi client shows it in its webview (and
 * as `/client` shows it in a browser, for testing). wash-fps-rust
 * docs/research/WEBVIEW_LOBBY.md, sections 4, 9, 10 and 11.
 *
 * It boots what the lobby needs from `main.ts` and none of the renderer:
 * no Babylon engine, scene, camera or map. Matches, demos and the window
 * belong to the native client, reached through `NativeBridge`.
 */

import "../../../../style.css";
import "../../../../engine/ui/styles/WashikiFonts.css";
import { registerEngineServices, ServiceLocator } from "../../../../engine/core";
import { EngineVersion } from "../../../../engine/core/EngineVersion";
import { GamePaths } from "../../../../engine/core/GamePaths";
import { DebugConsole } from "../../../../engine/debug";
import { configureLobbyTwin } from "../../../../engine/ui/components/LobbyTwin";
import { registerNetworkConnector } from "../../../../engine/ui/components/NetworkConnector";
import { LoadingScreen } from "../../../../engine/ui/LoadingScreen";
import { installStaleBuildNotice } from "../../../../engine/ui/StaleBuildNotice";
import { UIScale } from "../../../../engine/ui/UIScale";
import { UITheme } from "../../../../engine/ui/UITheme";
import browserConfig from "../../browser.json";
import gameJson from "../../game.json";
import { LobbyPanel } from "../LobbyPanel";
import { showMatchConnectionFailure } from "../MatchConnectionFailure";
import { installLinkPolicy } from "./LinkPolicy";
import { NativeBridge } from "./NativeBridge";
import { NativeNetworkConnector, takeAfterMatch } from "./NativeNetworkConnector";
import { installNativeKeys, installShellControls } from "./ShellControls";

/** How long past the player's click the start-up screen waits for the lobby to log them in. */
const LOBBY_ANSWER_WAIT_MS = 4000;

async function main(): Promise<void> {
  const bridge = NativeBridge.get();
  if (bridge.isNative()) document.documentElement.dataset.shell = "native";
  // Back from a match: no start click again, and a failed match says why.
  const afterMatch = bridge.isNative() ? takeAfterMatch() : null;

  configureLobbyTwin({ brand: { logo: "/data/washoi.png", name: "WASHIKI WASHOI" } });
  const loadingScreen = new LoadingScreen();
  loadingScreen.show();
  loadingScreen.setStatus("Starting the lobby...", "initialization");

  GamePaths.getInstance().initFromConfig(browserConfig.engine, gameJson.displayName);
  EngineVersion.getInstance().setDocumentTitle();
  installStaleBuildNotice();
  registerEngineServices();
  await ServiceLocator.getInstance().initCore();

  if (bridge.isNative()) {
    try {
      await bridge.sayHello(EngineVersion.getInstance().getVersionString());
    } catch (error) {
      console.warn("[NativeLobby] The client did not answer hello:", error);
    }
    installLinkPolicy(bridge);
    installNativeKeys(bridge);
    registerNetworkConnector(new NativeNetworkConnector(bridge));
  }

  DebugConsole.getInstance().enable();
  UIScale.getInstance().init();
  await UITheme.getInstance().loadShareTechMonoFont();

  const userReadyPromise = loadingScreen.waitForReady();
  // The player clicked to start before the match; the reload does not ask again.
  if (afterMatch) LoadingScreen.forceDismiss();
  loadingScreen.setStep("lobby");
  loadingScreen.setStatus("Connecting to the lobby...");
  const lobby = new LobbyPanel();
  await Promise.race([lobby.connected, new Promise((resolve) => setTimeout(resolve, LOBBY_ANSWER_WAIT_MS))]);
  loadingScreen.markReady();
  await userReadyPromise;
  loadingScreen.hide();
  lobby.show();
  lobby.initialLoadingDismissed();
  if (bridge.isNative()) installShellControls(bridge);
  if (afterMatch?.message) showMatchConnectionFailure(afterMatch.message, () => undefined);
  (window as Window & { __lobbyPanel?: LobbyPanel }).__lobbyPanel = lobby;
}

main().catch((error) => {
  console.error(error);
  LoadingScreen.failBoot(error);
});
