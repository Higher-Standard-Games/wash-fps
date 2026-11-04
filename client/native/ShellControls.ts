/**
 * What the native client adds to the lobby (WEBVIEW_LOBBY.md, sections 10
 * and 11): Alt+Enter and F11 for fullscreen, which the native window never
 * sees while the webview has the keyboard; a Quit key; the client's version
 * beside the web version.
 */

import type { NativeBridge } from "./NativeBridge";

/** Keys the native window would handle if it had the keyboard. */
export function installNativeKeys(bridge: NativeBridge, win: Window = window): void {
  win.addEventListener(
    "keydown",
    (event) => {
      const fullscreen = (event.key === "Enter" && event.altKey) || event.code === "F11";
      if (!fullscreen || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      bridge.post("window:fullscreen");
    },
    true,
  );
}

/** The Quit key and the client version, in the lobby's corner row. */
export function installShellControls(bridge: NativeBridge, doc: Document = document): void {
  const version = doc.querySelector(".lobby-version");
  const row = version?.parentElement;
  if (!row || row.querySelector(".lobby-quit-key")) return;
  const client = bridge.info()?.clientVersion;
  if (version && client) version.textContent = `client ${client} · ${version.textContent ?? ""}`;
  const quit = doc.createElement("button");
  quit.type = "button";
  quit.className = "lobby-credits-key lobby-quit-key";
  quit.textContent = "QUIT";
  quit.title = "Close Washoi";
  quit.addEventListener("click", () => bridge.post("app:quit"));
  row.appendChild(quit);
}
