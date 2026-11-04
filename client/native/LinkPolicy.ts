/**
 * Links in the native client (WEBVIEW_LOBBY.md, section 9): pages of this
 * site stay in the webview; anything else opens in the system browser. The
 * native client's navigation handler refuses other sites as well, so this
 * is the polite path, not the only guard.
 */

import type { NativeBridge } from "./NativeBridge";

/** Whether `href` leaves this site, judged against `origin`. */
export function isExternal(href: string, origin: string): boolean {
  try {
    const url = new URL(href, origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.origin !== origin;
  } catch {
    return false;
  }
}

export function installLinkPolicy(bridge: NativeBridge, win: Window = window): void {
  const origin = win.location.origin;
  win.document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      const link = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.hasAttribute("download")) return;
      if (!isExternal(link.href, origin)) return;
      event.preventDefault();
      bridge.post("open:external", { url: link.href });
    },
    true,
  );
  const open = win.open.bind(win);
  win.open = (url?: string | URL, ...rest: unknown[]) => {
    const href = url === undefined ? "" : String(url);
    if (href && isExternal(href, origin)) {
      bridge.post("open:external", { url: new URL(href, origin).href });
      return null;
    }
    return open(url, ...(rest as [string?, string?]));
  };
}
