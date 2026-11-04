/**
 * The settings over a native match (wash-fps-rust docs/research/WEBVIEW_LOBBY.md,
 * section 8). The match runs in the native client with this page hidden; the
 * match menu's Settings key sends `settings:open { kicker }`, the client shows
 * the page, and the page opens the same settings overlay the browser's match
 * menu opens. Back or Escape closes it and posts `settings:closed`, and the
 * client hides the page and brings its match menu back. The settings flow to
 * the client's files and live cvars through the storage mirror, as in the lobby.
 *
 * `settings:ready` tells the client this page can do it; an older page never
 * says so, and the client leaves the Settings key off its menu.
 */

import type { NativeBridge } from "./NativeBridge";

/** What the overlay needs to be: `SettingsRailOverlay`, or a test's stand-in. */
export interface MatchSettingsPanel {
  openWith(kicker: string): void;
  onClose(callback: () => void): void;
  isOpen(): boolean;
}

/** Listens for `settings:open`; the panel is made on the first one. Returns the way to stop. */
export function installMatchSettings(bridge: NativeBridge, makePanel: () => MatchSettingsPanel): () => void {
  let panel: MatchSettingsPanel | null = null;
  const stop = bridge.on("settings:open", (message) => {
    if (!panel) {
      panel = makePanel();
      panel.onClose(() => bridge.post("settings:closed"));
    }
    if (panel.isOpen()) return;
    panel.openWith(typeof message.kicker === "string" ? message.kicker : "");
  });
  bridge.post("settings:ready");
  return stop;
}
