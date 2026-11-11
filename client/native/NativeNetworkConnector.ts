/**
 * NativeNetworkConnector — in the native client, the lobby's matches are
 * played by the client's own renderer (WEBVIEW_LOBBY.md, section 6). The
 * lobby views hand every connection to the registered NetworkConnector; this
 * one passes it over the bridge and waits for the client's answer.
 *
 * `match:ended` brings the player back: the page reloads the lobby, as the
 * browser's single-match flow does (`ReturnToLobby.ts`).
 */

import { PlayerProfile } from "../../../../engine/player/PlayerProfile";
import type { NetworkConnectOptions, NetworkConnector } from "../../../../engine/ui/components/NetworkConnector";
import { BridgeError, type NativeBridge } from "./NativeBridge";
import { silencePageMusic } from "./PageMusic";

/** How long a connection may take before the overlay gives up on it. */
const CONNECT_TIMEOUT_MS = 60_000;

/** sessionStorage: how the last match ended, read once by the reloaded lobby. */
const AFTER_MATCH_KEY = "washoi.native.after_match";

/** How the client's last match ended, as `match:ended` said (WEBVIEW_LOBBY.md 6). */
export interface AfterMatch {
  /** `returned` (the player went back) or `disconnected` (the match failed). */
  reason: string;
  message?: string;
}

/** The match this page was reloaded after, once: the key is removed as it is read. */
export function takeAfterMatch(
  storage: Pick<Storage, "getItem" | "removeItem"> | null = safeSession(),
): AfterMatch | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(AFTER_MATCH_KEY);
    storage.removeItem(AFTER_MATCH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AfterMatch>;
    if (typeof parsed.reason !== "string") return null;
    return typeof parsed.message === "string" && parsed.message
      ? { reason: parsed.reason, message: parsed.message }
      : { reason: parsed.reason };
  } catch {
    return null;
  }
}

function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export class NativeNetworkConnector implements NetworkConnector {
  private inMatch = false;
  private serverUrl: string | null = null;
  private requestSeat: (() => Promise<void>) | null = null;

  constructor(
    private readonly bridge: NativeBridge,
    private readonly reload: () => void = () => window.location.replace(`${window.location.origin}/client`),
    private readonly silence: () => () => void = silencePageMusic,
  ) {
    bridge.on("match:started", () => {
      this.inMatch = true;
      // The client plays the match's music; the reloaded lobby starts its own.
      this.silence();
    });
    bridge.on("match:ended", (ended) => {
      this.inMatch = false;
      this.serverUrl = null;
      const reason = typeof ended.reason === "string" ? ended.reason : "returned";
      const after: AfterMatch = { reason };
      if (typeof ended.message === "string" && ended.message) after.message = ended.message;
      try {
        safeSession()?.setItem(AFTER_MATCH_KEY, JSON.stringify(after));
      } catch {
        // Without storage the lobby starts as on a first launch.
      }
      this.reload();
    });
    bridge.on("match:seat_wanted", () => {
      const ask = this.requestSeat;
      if (!ask) return;
      ask().catch((error) => this.bridge.post("match:seat_refused", { reason: String(error?.message ?? error) }));
    });
  }

  isConnected(): boolean {
    return this.inMatch;
  }

  async connect(serverUrl: string, options: NetworkConnectOptions = {}): Promise<void> {
    const watchOnly = options.watchOnly === true || options.autoJoin === false;
    this.requestSeat = options.requestSeat ?? null;
    const payload: Record<string, unknown> = {
      serverUrl,
      name: PlayerProfile.load().name,
    };
    let team: string | null = null;
    try {
      team = sessionStorage.getItem("shag.lobby_team");
    } catch {
      // A team is a preference; without storage the server picks.
    }
    if (team) payload.team = team;
    if (!watchOnly && options.admissionTicket) payload.admissionTicket = options.admissionTicket;
    try {
      await this.bridge.request(watchOnly ? "match:watch" : "match:play", payload, CONNECT_TIMEOUT_MS);
      this.serverUrl = serverUrl;
    } catch (error) {
      // The overlay recovers a refused ticket when the text says so.
      if (error instanceof BridgeError && error.code === "invalid_ticket") throw new Error("invalid match ticket");
      throw error;
    }
  }

  /**
   * A watcher of this server takes a seat: the client joins on the connection
   * it has. Only a client that offers `seat` can; others leave the overlay to
   * start a new connection.
   */
  claimSeat(serverUrl: string, admissionTicket: string): boolean {
    if (!this.bridge.has("seat") || !this.inMatch || this.serverUrl !== serverUrl) return false;
    this.bridge.post("match:seat", { serverUrl, admissionTicket });
    return true;
  }
}
