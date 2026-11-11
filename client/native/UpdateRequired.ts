/**
 * The oldest native client this lobby page still works with. The page is
 * always the current one (it is served from washoi.net), so it is what turns
 * away a client too old for today's game servers, bridge or lobby: a
 * full-window notice with the download and Quit, and no lobby behind it.
 *
 * Raise `MIN_NATIVE_CLIENT` to the first client version that works with a
 * change, in the same deployment as the change: a new snapshot field, message
 * type or bridge message the old clients cannot read. An installed Windows
 * client updates itself before it opens this page (wash-fps-rust
 * `update_check::self_update`), so only players who skipped or could not take
 * that update see the notice.
 */

import type { NativeBridge } from "./NativeBridge";

/** The oldest native client the servers and this page accept. */
export const MIN_NATIVE_CLIENT = "0.1.0";

/** `1.2.3` or `1.2.3-rc.1`: the numbers, and whether it is a pre-release. */
function parseVersion(version: string): { parts: [number, number, number]; pre: boolean } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] !== undefined };
}

/**
 * Whether `client` is older than `minimum`: a pre-release comes before its
 * release. A client that names no readable version is let in, as an old page
 * would have let it in.
 */
export function clientTooOld(client: string | undefined, minimum: string = MIN_NATIVE_CLIENT): boolean {
  const c = client === undefined ? null : parseVersion(client);
  const m = parseVersion(minimum);
  if (!c || !m) return false;
  for (let i = 0; i < 3; i++) {
    if (c.parts[i] !== m.parts[i]) return c.parts[i] < m.parts[i];
  }
  return c.pre && !m.pre;
}

/**
 * The notice in place of the lobby. The download link comes with the
 * client's own update check (`native:update`), which arrives a moment later;
 * until it does, or when there is no package for this machine, the notice
 * names washoi.net.
 */
export function showUpdateRequired(bridge: NativeBridge, doc: Document = document): () => void {
  const client = bridge.info()?.clientVersion ?? "?";
  const notice = doc.createElement("div");
  notice.className = "native-update-required";
  notice.setAttribute("role", "alertdialog");
  notice.setAttribute("aria-label", "Update required");
  Object.assign(notice.style, {
    position: "fixed",
    inset: "0",
    display: "flex",
    flexDirection: "column",
    gap: "18px",
    alignItems: "center",
    justifyContent: "center",
    background: "rgb(9, 8, 18)",
    color: "#f6ecd2",
    font: "600 18px/1.4 Rajdhani, sans-serif",
    textAlign: "center",
    zIndex: "100001",
  });
  const title = doc.createElement("h1");
  title.textContent = "UPDATE REQUIRED";
  Object.assign(title.style, { margin: "0", font: "700 32px/1.2 Orbitron, sans-serif", letterSpacing: "0.08em" });
  const text = doc.createElement("p");
  text.style.margin = "0";
  text.style.maxWidth = "520px";
  const say = (newer?: string) => {
    text.textContent = newer
      ? `Washoi ${client} is too old for the servers. Download Washoi ${newer} to keep playing.`
      : `Washoi ${client} is too old for the servers. Get the new version from washoi.net to keep playing.`;
  };
  say();
  const keys = doc.createElement("div");
  Object.assign(keys.style, { display: "flex", gap: "12px" });
  const get = doc.createElement("button");
  get.type = "button";
  get.className = "lobby-credits-key native-update-required__get";
  get.textContent = "DOWNLOAD";
  get.hidden = true;
  let url: string | null = null;
  get.addEventListener("click", () => {
    if (url) bridge.post("open:external", { url });
  });
  const quit = doc.createElement("button");
  quit.type = "button";
  quit.className = "lobby-credits-key native-update-required__quit";
  quit.textContent = "QUIT";
  quit.addEventListener("click", () => bridge.post("app:quit"));
  keys.append(get, quit);
  notice.append(title, text, keys);
  doc.body.append(notice);
  return bridge.on("native:update", (message) => {
    if (typeof message.version !== "string") return;
    say(message.version);
    if (typeof message.url === "string" && message.url.startsWith("https://")) {
      url = message.url;
      get.hidden = false;
    }
  });
}
