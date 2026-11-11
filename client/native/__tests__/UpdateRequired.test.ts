// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { NativeBridge } from "../NativeBridge";
import { clientTooOld, showUpdateRequired } from "../UpdateRequired";

afterEach(() => document.body.replaceChildren());

describe("clientTooOld", () => {
  it("compares by number, and a pre-release comes before its release", () => {
    expect(clientTooOld("0.1.0", "0.2.0")).toBe(true);
    expect(clientTooOld("0.9.0", "0.10.0")).toBe(true);
    expect(clientTooOld("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(clientTooOld("0.2.0", "0.2.0")).toBe(false);
    expect(clientTooOld("0.2.1", "0.2.0")).toBe(false);
    expect(clientTooOld("1.0.0", "1.0.0-rc.1")).toBe(false);
    expect(clientTooOld("v0.3.0", "0.2.0")).toBe(false);
  });

  it("lets in a client whose version it cannot read", () => {
    expect(clientTooOld(undefined, "9.0.0")).toBe(false);
    expect(clientTooOld("dev", "9.0.0")).toBe(false);
    expect(clientTooOld("1.0", "9.0.0")).toBe(false);
  });

  it("lets in today's clients", () => {
    expect(clientTooOld("0.1.0")).toBe(false);
    expect(clientTooOld("0.1.1")).toBe(false);
  });
});

describe("showUpdateRequired", () => {
  function setup() {
    const sent: Record<string, unknown>[] = [];
    const bridge = new NativeBridge({
      __washoiNative: { shell: "washoi-native", clientVersion: "0.1.0", capabilities: ["update"] },
      ipc: { postMessage: (text: string) => sent.push(JSON.parse(text)) },
      location: { pathname: "/client" },
    } as never);
    showUpdateRequired(bridge);
    return { bridge, sent };
  }

  it("offers the download once the client's update check names it, and Quit", () => {
    const { bridge, sent } = setup();
    const get = document.querySelector<HTMLButtonElement>(".native-update-required__get");
    expect(get?.hidden).toBe(true);
    expect(document.querySelector(".native-update-required")?.textContent).toContain("washoi.net");
    bridge.receive({ v: 1, type: "native:update", version: "0.2.0", url: "https://washoi.net/client/0.2.0/x.zip" });
    expect(get?.hidden).toBe(false);
    expect(document.querySelector(".native-update-required")?.textContent).toContain("Washoi 0.2.0");
    get?.click();
    document.querySelector<HTMLButtonElement>(".native-update-required__quit")?.click();
    expect(sent.map((m) => m.type)).toEqual(["open:external", "app:quit"]);
    expect(sent[0]?.url).toBe("https://washoi.net/client/0.2.0/x.zip");
  });

  it("offers no link that is not https", () => {
    const { bridge } = setup();
    bridge.receive({ v: 1, type: "native:update", version: "0.2.0", url: "file:///x" });
    expect(document.querySelector<HTMLButtonElement>(".native-update-required__get")?.hidden).toBe(true);
  });
});
