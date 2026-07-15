/**
 * ProtocolTestClient — a minimal real WebSocket client for the GameServer
 * protocol smoke suite (QA-WO1).
 *
 * Connects to a running GameServer over a real `ws` socket, sends raw
 * `MessageCodec`-encoded frames, and lets tests await decoded responses. This
 * is deliberately transport-level: it exercises the exact `handleDatagram`
 * routing path that shipped the broken-chat bug (which every mocked-transport
 * unit test missed).
 *
 * Not a `.test.ts` file — imported by the smoke suite, not run directly.
 */
import { WebSocket } from "ws";
import type { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";

interface Waiter {
  match: (frame: Uint8Array) => boolean;
  resolve: (frame: Uint8Array) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ProtocolTestClient {
  /** Every binary frame received from the server, in arrival order. */
  readonly frames: Uint8Array[] = [];
  private waiters: Waiter[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      const frame = new Uint8Array(data);
      this.frames.push(frame);
      for (const w of [...this.waiters]) {
        if (w.match(frame)) {
          clearTimeout(w.timer);
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(frame);
        }
      }
    });
  }

  /** Open a connection and resolve once the socket is established. */
  static connect(port: number, timeoutMs = 3000): Promise<ProtocolTestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => reject(new Error(`connect timeout on port ${port}`)), timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new ProtocolTestClient(ws));
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  /**
   * Resolve with the first received frame (past or future) matching `match`.
   * Rejects after `timeoutMs`.
   */
  waitFor(match: (frame: Uint8Array) => boolean, timeoutMs = 3000): Promise<Uint8Array> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error("waitFor: timed out"));
      }, timeoutMs);
      this.waiters.push({ match, resolve, timer });
    });
  }

  /** Convenience: wait for the first frame whose leading byte is `type`. */
  waitForType(type: MessageType, timeoutMs = 3000): Promise<Uint8Array> {
    return this.waitFor((f) => f.length > 0 && f[0] === type, timeoutMs);
  }

  async close(): Promise<void> {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
