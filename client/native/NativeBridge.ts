/**
 * NativeBridge — the page's side of the bridge to the native Washoi client
 * (wash-fps-rust docs/research/WEBVIEW_LOBBY.md, section 5).
 *
 * The native client injects `window.__washoiNative` before any page script
 * runs. Messages go to it with `window.ipc.postMessage(json)` and come back
 * through `__washoiNative.receive(msg)`. Every message is a JSON object with
 * `v` (the bridge version) and `type`; a request carries an `id` and its
 * answer the same `id`. In a browser there is no bridge: `isNative()` is
 * false and nothing here does anything.
 */

/** The bridge version this page speaks. */
export const BRIDGE_VERSION = 1;

/** What the native client injects. */
export interface NativeShellInfo {
  shell: "washoi-native";
  bridgeVersion: number;
  clientVersion: string;
  platform: string;
  capabilities: string[];
  /** The mirrored local storage keys from the client's files (NativeStorage.ts). */
  storage?: Record<string, string>;
  /** The client's cvar declarations (shagger `Cvars::declarations`). */
  cvars?: unknown[];
  receive(message: BridgeMessage): void;
}

export interface BridgeMessage {
  v: number;
  type: string;
  id?: string;
  [field: string]: unknown;
}

interface ShellWindow {
  __washoiNative?: NativeShellInfo;
  ipc?: { postMessage(text: string): void };
  location: { pathname: string };
}

/** The page to boot is the lobby alone: inside the native client, or at `/client`. */
export function lobbyOnly(win: ShellWindow): boolean {
  return win.__washoiNative?.shell === "washoi-native" || /^\/client\/?$/.test(win.location.pathname);
}

/** A request the native client refused or did not answer. */
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (message: BridgeMessage) => void;

const REQUEST_TIMEOUT_MS = 15_000;

export class NativeBridge {
  private static instance: NativeBridge | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly pending = new Map<
    string,
    { resolve: (m: BridgeMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;
  private hello: BridgeMessage | null = null;

  /** A bridge over `win`; tests pass their own window. */
  constructor(private readonly win: ShellWindow = window as unknown as ShellWindow) {
    const info = win.__washoiNative;
    if (info) info.receive = (message) => this.receive(message);
  }

  static get(): NativeBridge {
    NativeBridge.instance ??= new NativeBridge();
    return NativeBridge.instance;
  }

  /** Running inside the native client. */
  isNative(): boolean {
    return this.win.__washoiNative?.shell === "washoi-native" && !!this.win.ipc;
  }

  /** What the client said about itself, before `hello` is answered too. */
  info(): NativeShellInfo | null {
    return this.isNative() ? (this.win.__washoiNative ?? null) : null;
  }

  /** Whether the native client offers `capability`, from its `hello` answer or what it injected. */
  has(capability: string): boolean {
    const listed = (this.hello?.capabilities as string[] | undefined) ?? this.info()?.capabilities ?? [];
    return listed.includes(capability);
  }

  /** Send a message that wants no answer. Does nothing in a browser. */
  post(type: string, payload: Record<string, unknown> = {}): void {
    if (!this.isNative()) return;
    this.win.ipc?.postMessage(JSON.stringify({ ...payload, v: BRIDGE_VERSION, type }));
  }

  /** Send a request; resolves with the answer, rejects with a `BridgeError`. */
  request(type: string, payload: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<BridgeMessage> {
    if (!this.isNative()) return Promise.reject(new BridgeError("not_native", "Not running in the Washoi client"));
    const id = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("timeout", `The Washoi client did not answer ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.win.ipc?.postMessage(JSON.stringify({ ...payload, v: BRIDGE_VERSION, type, id }));
    });
  }

  /** Listen for an event from the native client; returns the way to stop. */
  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** `hello`: tell the client who we are and learn what it can do. */
  async sayHello(webVersion: string): Promise<BridgeMessage> {
    this.hello = await this.request("hello", { webVersion, bridgeVersion: BRIDGE_VERSION });
    return this.hello;
  }

  /** A message from the native client: an answer to a request, or an event. */
  receive(message: BridgeMessage): void {
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;
    if (message.id && this.pending.has(message.id)) {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      if (message.type === "error") {
        waiting.reject(new BridgeError(String(message.code ?? "error"), String(message.message ?? "Request failed")));
      } else {
        waiting.resolve(message);
      }
      return;
    }
    for (const handler of this.handlers.get(message.type) ?? []) {
      try {
        handler(message);
      } catch (error) {
        console.error(`[NativeBridge] ${message.type} handler failed:`, error);
      }
    }
  }
}
