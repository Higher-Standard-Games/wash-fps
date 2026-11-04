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

/**
 * `native:update`: a newer client is out. A notice in the corner offers the
 * download in the system browser, or Later, which the client remembers for
 * this run (`update:dismiss`).
 */
export function installUpdateNotice(bridge: NativeBridge, doc: Document = document): () => void {
  return bridge.on("native:update", (message) => {
    if (typeof message.version !== "string" || doc.querySelector(".native-update")) return;
    const url = typeof message.url === "string" && message.url.startsWith("https://") ? message.url : null;
    const notice = doc.createElement("div");
    notice.className = "native-update";
    notice.setAttribute("role", "status");
    Object.assign(notice.style, {
      position: "fixed",
      right: "24px",
      top: "24px",
      display: "flex",
      gap: "10px",
      alignItems: "center",
      padding: "10px 14px",
      background: "rgba(16, 12, 32, 0.92)",
      color: "#f6ecd2",
      font: "600 15px/1.3 Rajdhani, sans-serif",
      borderRadius: "4px",
      zIndex: "100000",
    });
    const text = doc.createElement("span");
    text.textContent = url
      ? `Washoi ${message.version} is out.`
      : `Washoi ${message.version} is out; get it from washoi.net.`;
    notice.append(text);
    const close = () => notice.remove();
    if (url) {
      const get = doc.createElement("button");
      get.type = "button";
      get.className = "lobby-credits-key native-update__get";
      get.textContent = "DOWNLOAD";
      get.addEventListener("click", () => {
        bridge.post("open:external", { url });
        bridge.post("update:dismiss");
        close();
      });
      notice.append(get);
    }
    const later = doc.createElement("button");
    later.type = "button";
    later.className = "lobby-credits-key native-update__later";
    later.textContent = "LATER";
    later.addEventListener("click", () => {
      bridge.post("update:dismiss");
      close();
    });
    notice.append(later);
    doc.body.append(notice);
  });
}
