/**
 * Invites in the native client (wash-fps-rust docs/research/WEBVIEW_LOBBY.md,
 * section 9): a friend's room link cannot be opened in the client, so
 * pasting it anywhere outside a text field joins the room, the same deep
 * link (`?lobby=<id>&invite=<token>`) the browser would follow.
 */

export type InviteTarget = { kind: "join"; url: string } | { kind: "elsewhere"; host: string };

/** Where a pasted `text` leads: this lobby's room, another site's, or nowhere (null). */
export function inviteTarget(text: string, origin: string): InviteTarget | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const lobby = url.searchParams.get("lobby") ?? url.pathname.match(/^\/lobby\/([A-Za-z0-9_-]+)\/?$/)?.[1] ?? null;
  if (!lobby || !/^[A-Za-z0-9_-]{1,64}$/.test(lobby)) return null;
  if (url.origin !== origin) return { kind: "elsewhere", host: url.host };
  const target = new URL("/client", origin);
  target.searchParams.set("lobby", lobby);
  const invite = url.searchParams.get("invite");
  if (invite && /^[A-Za-z0-9_-]{1,128}$/.test(invite)) target.searchParams.set("invite", invite);
  return { kind: "join", url: target.href };
}

function editable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

function say(doc: Document, text: string): void {
  const notice = doc.createElement("div");
  notice.className = "native-invite-notice";
  notice.setAttribute("role", "status");
  notice.textContent = text;
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
  });
  doc.body.append(notice);
  setTimeout(() => notice.remove(), 5000);
}

export function installInvitePaste(
  win: Window = window,
  go: (url: string) => void = (url) => win.location.assign(url),
): void {
  win.document.addEventListener("paste", (event) => {
    if (editable(event.target)) return;
    const text = event.clipboardData?.getData("text") ?? "";
    const target = inviteTarget(text, win.location.origin);
    if (!target) return;
    event.preventDefault();
    if (target.kind === "join") {
      say(win.document, "Joining the room…");
      go(target.url);
    } else {
      say(win.document, `That invite is for ${target.host}. Pick that region at start to join it.`);
    }
  });
}
