// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { NativeBridge } from "../NativeBridge";
import { installUpdateNotice } from "../ShellControls";

afterEach(() => document.body.replaceChildren());

function setup() {
  const sent: Record<string, unknown>[] = [];
  const bridge = new NativeBridge({
    __washoiNative: { shell: "washoi-native", capabilities: ["update"] },
    ipc: { postMessage: (text: string) => sent.push(JSON.parse(text)) },
    location: { pathname: "/client" },
  } as never);
  installUpdateNotice(bridge);
  return { bridge, sent };
}

describe("installUpdateNotice", () => {
  it("offers the download once and opens it in the browser", () => {
    const { bridge, sent } = setup();
    const update = { v: 1, type: "native:update", version: "0.2.0", url: "https://washoi.net/client/washoi-0.2.0.zip" };
    bridge.receive(update);
    bridge.receive(update);
    expect(document.querySelectorAll(".native-update")).toHaveLength(1);
    document.querySelector<HTMLButtonElement>(".native-update__get")?.click();
    expect(sent.map((m) => m.type)).toEqual(["open:external", "update:dismiss"]);
    expect(document.querySelector(".native-update")).toBeNull();
  });

  it("offers no link that is not https", () => {
    const { bridge, sent } = setup();
    bridge.receive({ v: 1, type: "native:update", version: "0.2.0", url: "file:///x" });
    expect(document.querySelector(".native-update__get")).toBeNull();
    document.querySelector<HTMLButtonElement>(".native-update__later")?.click();
    expect(sent.map((m) => m.type)).toEqual(["update:dismiss"]);
  });
});
