// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { NativeBridge } from "../NativeBridge";
import { NativeNetworkConnector, takeAfterMatch } from "../NativeNetworkConnector";

function setup() {
  const sent: Record<string, unknown>[] = [];
  const win = {
    __washoiNative: { shell: "washoi-native", capabilities: ["match", "seat"] } as Record<string, unknown>,
    ipc: { postMessage: (text: string) => sent.push(JSON.parse(text)) },
    location: { pathname: "/client" },
  };
  const bridge = new NativeBridge(win as never);
  let reloads = 0;
  const connector = new NativeNetworkConnector(bridge, () => reloads++);
  return { bridge, connector, sent, reloads: () => reloads };
}

afterEach(() => sessionStorage.clear());

describe("NativeNetworkConnector", () => {
  it("asks the client to play with the ticket, name and team", async () => {
    const { bridge, connector, sent } = setup();
    sessionStorage.setItem("shag.lobby_team", "red");
    const done = connector.connect("ws://game:7777", { admissionTicket: "t1" });
    expect(sent[0]).toMatchObject({
      type: "match:play",
      serverUrl: "ws://game:7777",
      admissionTicket: "t1",
      team: "red",
    });
    bridge.receive({ v: 1, type: "match:play", id: sent[0].id as string, ok: true });
    bridge.receive({ v: 1, type: "match:started" });
    await done;
    expect(connector.isConnected()).toBe(true);
    expect(connector.claimSeat("ws://game:7777", "t2")).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: "match:seat", admissionTicket: "t2" });
    expect(connector.claimSeat("ws://other", "t3")).toBe(false);
  });

  it("leaves seats to the overlay when the client cannot change them", async () => {
    const bridge = new NativeBridge({
      __washoiNative: { shell: "washoi-native", capabilities: ["match"] },
      ipc: { postMessage: () => undefined },
      location: { pathname: "/client" },
    } as never);
    const connector = new NativeNetworkConnector(bridge, () => undefined);
    bridge.receive({ v: 1, type: "match:started" });
    expect(connector.claimSeat("ws://game:7777", "t")).toBe(false);
  });

  it("watches without a ticket", () => {
    const { connector, sent } = setup();
    void connector.connect("ws://game:7777", { watchOnly: true, admissionTicket: "t1" });
    expect(sent[0].type).toBe("match:watch");
    expect(sent[0].admissionTicket).toBeUndefined();
  });

  it("turns a refused ticket into the overlay's recovery error", async () => {
    const { bridge, connector, sent } = setup();
    const done = connector.connect("ws://game:7777", { admissionTicket: "old" });
    bridge.receive({ v: 1, type: "error", id: sent[0].id as string, code: "invalid_ticket", message: "x" });
    await expect(done).rejects.toThrow("invalid match ticket");
  });

  it("reloads the lobby when the match ends, keeping how it ended for once", () => {
    const { bridge, connector, reloads } = setup();
    bridge.receive({ v: 1, type: "match:started" });
    bridge.receive({ v: 1, type: "match:ended", reason: "disconnected", message: "server went away" });
    expect(connector.isConnected()).toBe(false);
    expect(reloads()).toBe(1);
    expect(takeAfterMatch()).toEqual({ reason: "disconnected", message: "server went away" });
    expect(takeAfterMatch()).toBeNull();
  });

  it("ignores a broken after-match record", () => {
    sessionStorage.setItem("washoi.native.after_match", "{nope");
    expect(takeAfterMatch()).toBeNull();
    sessionStorage.setItem("washoi.native.after_match", JSON.stringify({ reason: "returned" }));
    expect(takeAfterMatch()).toEqual({ reason: "returned" });
  });
});
