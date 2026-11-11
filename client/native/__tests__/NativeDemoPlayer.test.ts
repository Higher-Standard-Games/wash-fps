import { describe, expect, it } from "vitest";
import type { DemoInfo } from "../../../../../lobby/types";
import { NativeBridge } from "../NativeBridge";
import { demoBase, NativeDemoPlayer } from "../NativeDemoPlayer";

function setup() {
  const sent: Record<string, unknown>[] = [];
  const bridge = new NativeBridge({
    __washoiNative: { shell: "washoi-native", capabilities: ["demo"] },
    ipc: { postMessage: (text: string) => sent.push(JSON.parse(text)) },
    location: { pathname: "/client" },
  } as never);
  const music = { silenced: 0, resumed: 0 };
  const silence = () => {
    music.silenced++;
    return () => music.resumed++;
  };
  return { bridge, sent, music, player: new NativeDemoPlayer(bridge, "https://eu.washoi.net/data/demos", silence) };
}

const demo = { filename: "m1.shagdemo", map: "washoi_dm2" } as DemoInfo;

describe("demoBase", () => {
  it("is absolute, without a trailing slash", () => {
    expect(demoBase("https://eu.washoi.net", undefined)).toBe("https://eu.washoi.net/data/demos");
    expect(demoBase("https://eu.washoi.net", "https://cdn.example/demos/")).toBe("https://cdn.example/demos");
  });
});

describe("NativeDemoPlayer", () => {
  it("asks the client to play and hears when it ends", async () => {
    const { bridge, sent, music, player } = setup();
    let ended = 0;
    const started = player.play(demo, 2, new AbortController().signal, () => ended++);
    expect(sent[0]).toMatchObject({ type: "demo:play", filename: "m1.shagdemo", reel: 2 });
    // The menus' music plays on while the recording downloads.
    expect(music.silenced).toBe(0);
    bridge.receive({ v: 1, type: "ok", id: sent[0].id as string });
    await started;
    expect(music).toEqual({ silenced: 1, resumed: 0 });
    bridge.receive({ v: 1, type: "demo:ended" });
    bridge.receive({ v: 1, type: "demo:ended" });
    expect(ended).toBe(1);
    expect(music).toEqual({ silenced: 1, resumed: 1 });
  });

  it("turns a cancel into an AbortError", async () => {
    const { bridge, sent, player } = setup();
    const controller = new AbortController();
    const started = player.play(demo, undefined, controller.signal, () => undefined);
    expect(sent[0].reel).toBeUndefined();
    controller.abort();
    expect(sent[1]).toMatchObject({ type: "demo:cancel" });
    bridge.receive({ v: 1, type: "error", id: sent[0].id as string, code: "cancelled", message: "Cancelled." });
    await expect(started).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes a failed download on", async () => {
    const { bridge, sent, player } = setup();
    const started = player.play(demo, undefined, new AbortController().signal, () => undefined);
    bridge.receive({ v: 1, type: "error", id: sent[0].id as string, code: "download_failed", message: "Gone" });
    await expect(started).rejects.toThrow("Gone");
  });
});
