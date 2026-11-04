import { describe, expect, it, vi } from "vitest";
import { BRIDGE_VERSION, BridgeError, lobbyOnly, NativeBridge } from "../NativeBridge";

function nativeWindow() {
  const sent: Record<string, unknown>[] = [];
  const win = {
    __washoiNative: { shell: "washoi-native", capabilities: ["match"] } as Record<string, unknown>,
    ipc: { postMessage: (text: string) => sent.push(JSON.parse(text)) },
    location: { pathname: "/" },
  };
  return { win, sent };
}

describe("lobbyOnly", () => {
  it("boots the lobby alone inside the client or at /client", () => {
    expect(lobbyOnly({ location: { pathname: "/client" } })).toBe(true);
    expect(lobbyOnly({ location: { pathname: "/client/" } })).toBe(true);
    expect(lobbyOnly({ location: { pathname: "/" } })).toBe(false);
    expect(lobbyOnly({ location: { pathname: "/clientele" } })).toBe(false);
    expect(lobbyOnly({ __washoiNative: { shell: "washoi-native" }, location: { pathname: "/" } } as never)).toBe(true);
  });
});

describe("NativeBridge", () => {
  it("is quiet in a browser", async () => {
    const bridge = new NativeBridge({ location: { pathname: "/client" } });
    expect(bridge.isNative()).toBe(false);
    bridge.post("app:quit");
    await expect(bridge.request("hello")).rejects.toMatchObject({ code: "not_native" });
  });

  it("matches answers to requests by id", async () => {
    const { win, sent } = nativeWindow();
    const bridge = new NativeBridge(win as never);
    const answer = bridge.sayHello("1.0.0");
    expect(sent[0]).toMatchObject({ type: "hello", v: BRIDGE_VERSION, id: "r1", webVersion: "1.0.0" });
    (win.__washoiNative.receive as (m: unknown) => void)({
      v: 1,
      type: "hello",
      id: "r1",
      capabilities: ["match", "quit"],
    });
    await expect(answer).resolves.toMatchObject({ capabilities: ["match", "quit"] });
    expect(bridge.has("quit")).toBe(true);
    expect(bridge.has("clipboard")).toBe(false);
  });

  it("rejects an error answer with its code", async () => {
    const { win } = nativeWindow();
    const bridge = new NativeBridge(win as never);
    const answer = bridge.request("match:play", { serverUrl: "ws://x" });
    bridge.receive({ v: 1, type: "error", id: "r1", code: "invalid_ticket", message: "no" });
    const error = await answer.catch((e) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error.code).toBe("invalid_ticket");
  });

  it("times out an unanswered request", async () => {
    vi.useFakeTimers();
    const { win } = nativeWindow();
    const answer = new NativeBridge(win as never).request("hello", {}, 100);
    vi.advanceTimersByTime(101);
    await expect(answer).rejects.toMatchObject({ code: "timeout" });
    vi.useRealTimers();
  });

  it("hands events to their listeners until they stop", () => {
    const { win } = nativeWindow();
    const bridge = new NativeBridge(win as never);
    const seen: unknown[] = [];
    const stop = bridge.on("match:ended", (m) => seen.push(m.reason));
    bridge.receive({ v: 1, type: "match:ended", reason: "returned" });
    stop();
    bridge.receive({ v: 1, type: "match:ended", reason: "again" });
    bridge.receive({ nonsense: true } as never);
    expect(seen).toEqual(["returned"]);
  });
});
