/**
 * NativeDemoPlayer — in the native client, the Demos page's recordings are
 * fetched and played by the client's own player (wash-fps-rust
 * docs/research/WEBVIEW_LOBBY.md, section 10). The page sends `demo:play`,
 * the client answers once playback has started, and `demo:ended` brings
 * the page back. Cancel sends `demo:cancel`.
 */

import type { DemoInfo } from "../../../../lobby/types";
import type { DemoPlayer } from "../DemosView";
import { BridgeError, type NativeBridge } from "./NativeBridge";
import { silencePageMusic } from "./PageMusic";

/** A download of the largest recordings on a slow line, then the start. */
const PLAY_TIMEOUT_MS = 10 * 60_000;

/** Where recordings are served from, as `DemoService.demoBaseUrl`, made absolute. */
export function demoBase(origin: string, configured: string | undefined): string {
  return new URL(configured || "/data/demos", origin).href.replace(/\/+$/, "");
}

export class NativeDemoPlayer implements DemoPlayer {
  constructor(
    private readonly bridge: NativeBridge,
    private readonly base: string = demoBase(window.location.origin, import.meta.env.VITE_DEMO_BASE_URL),
    private readonly silence: () => () => void = silencePageMusic,
  ) {}

  async play(demo: DemoInfo, reelMinutes: number | undefined, signal: AbortSignal, ended: () => void): Promise<void> {
    // Once the recording plays, with its own sound, the menus' music waits
    // for its end.
    let resume = () => {};
    const stop = this.bridge.on("demo:ended", () => {
      stop();
      resume();
      ended();
    });
    const cancel = () => this.bridge.post("demo:cancel", { filename: demo.filename });
    signal.addEventListener("abort", cancel, { once: true });
    const payload: Record<string, unknown> = { filename: demo.filename, base: this.base, map: demo.map };
    if (reelMinutes !== undefined) payload.reel = reelMinutes;
    try {
      await this.bridge.request("demo:play", payload, PLAY_TIMEOUT_MS);
      resume = this.silence();
    } catch (error) {
      stop();
      if (signal.aborted || (error instanceof BridgeError && error.code === "cancelled")) {
        throw new DOMException("The recording was cancelled", "AbortError");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}
