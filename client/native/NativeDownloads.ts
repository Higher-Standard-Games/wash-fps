/**
 * Downloads in the native client (wash-fps-rust docs/research/WEBVIEW_LOBBY.md,
 * section 9). The webview refuses downloads, so a link that saves a file
 * made in the page (a `blob:` or `data:` URL with `download`, such as the
 * profile's key file) is handed to the client as `file:save`, which writes
 * it to the Downloads folder. A short notice says where it went.
 */

import type { NativeBridge } from "./NativeBridge";

/** Whether `link` saves a file the page made, rather than navigating. */
export function isPageDownload(link: Pick<HTMLAnchorElement, "href" | "hasAttribute">): boolean {
  return link.hasAttribute("download") && /^(blob|data):/.test(link.href);
}

async function saveThroughClient(bridge: NativeBridge, link: HTMLAnchorElement): Promise<void> {
  const response = await fetch(link.href);
  const blob = await response.blob();
  const text = await blob.text();
  const answer = await bridge.request("file:save", {
    suggestedName: link.getAttribute("download") || "washoi-file.txt",
    mime: blob.type || "text/plain",
    text,
  });
  if (answer.saved === true) showSavedNotice(typeof answer.path === "string" ? answer.path : "");
}

function showSavedNotice(path: string): void {
  const notice = document.createElement("div");
  notice.className = "native-saved-notice";
  notice.setAttribute("role", "status");
  notice.textContent = path ? `Saved to ${path}` : "Saved to your Downloads folder";
  Object.assign(notice.style, {
    position: "fixed",
    left: "50%",
    bottom: "24px",
    transform: "translateX(-50%)",
    padding: "10px 16px",
    background: "rgba(16, 12, 32, 0.92)",
    color: "#f6ecd2",
    font: "600 14px/1.3 Rajdhani, sans-serif",
    borderRadius: "4px",
    zIndex: "100000",
    maxWidth: "90vw",
    overflowWrap: "anywhere",
  });
  document.body.append(notice);
  setTimeout(() => notice.remove(), 5000);
}

/** Route the page's file downloads to the client. */
export function installDownloads(bridge: NativeBridge, win: Window = window): void {
  const save = (link: HTMLAnchorElement) => {
    saveThroughClient(bridge, link).catch((error) => console.warn("[NativeDownloads] Not saved:", error));
  };
  // Links in the page.
  win.document.addEventListener(
    "click",
    (event) => {
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || !isPageDownload(link)) return;
      event.preventDefault();
      save(link);
    },
    true,
  );
  // A link made and clicked in code, never in the document (`ProfileView.saveKeyFile`).
  const proto = (win as Window & typeof globalThis).HTMLAnchorElement.prototype;
  const click = proto.click;
  proto.click = function (this: HTMLAnchorElement) {
    if (!this.isConnected && isPageDownload(this)) {
      save(this);
      return;
    }
    click.call(this);
  };
}
