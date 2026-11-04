// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../../engine/core/Cvar";
import { NativeBridge } from "../NativeBridge";
import { applyNativeStorage, installStorageMirror, isMirrored, registerNativeCvars } from "../NativeStorage";

function bridge() {
  const sent: Record<string, unknown>[] = [];
  const b = new NativeBridge({
    __washoiNative: { shell: "washoi-native", capabilities: ["storage"] },
    ipc: { postMessage: (text: string) => sent.push(JSON.parse(text)) },
    location: { pathname: "/client" },
  } as never);
  return { b, sent };
}

let undo: (() => void) | null = null;
afterEach(() => {
  undo?.();
  undo = null;
  localStorage.clear();
  sessionStorage.clear();
});

describe("isMirrored", () => {
  it("matches the native mirror's keys", () => {
    for (const key of [
      "engine_cvars",
      "engine_binds",
      "shag.loadout.rocket",
      "shag_player_key",
      "shag_settings_sync",
    ]) {
      expect(isMirrored(key)).toBe(true);
    }
    for (const key of ["washoi.welcome.hideAutomatically", "pk3_index", "engine.renderVars"]) {
      expect(isMirrored(key)).toBe(false);
    }
  });
});

describe("applyNativeStorage", () => {
  it("copies the client's keys once per session", () => {
    localStorage.setItem("shag_player_key", "OLD");
    localStorage.setItem("hud-user-prefs", "{}");
    localStorage.setItem("washoi.terms.agreed", "x");
    const snapshot = { shag_player_key: "FILE", engine_binds: "{}", stray: "x" };
    const adopted: string[] = [];
    expect(applyNativeStorage(snapshot, localStorage, sessionStorage, (key) => adopted.push(key))).toBe(2);
    expect(adopted).toEqual(["hud-user-prefs"]);
    expect(localStorage.getItem("shag_player_key")).toBe("FILE");
    expect(localStorage.getItem("stray")).toBeNull();
    localStorage.setItem("shag_player_key", "NEWER");
    expect(applyNativeStorage(snapshot, localStorage, sessionStorage)).toBe(0);
    expect(localStorage.getItem("shag_player_key")).toBe("NEWER");
  });
});

describe("installStorageMirror", () => {
  it("sends the shared keys' writes, and only those", () => {
    const { b, sent } = bridge();
    undo = installStorageMirror(b);
    localStorage.setItem("engine_binds", '{"jump":["Space"]}');
    localStorage.setItem("washoi.terms.agreed", "x");
    sessionStorage.setItem("engine_binds", "session only");
    localStorage.removeItem("engine_binds");
    localStorage.removeItem("engine_binds");
    expect(sent).toEqual([
      { v: 1, type: "storage:set", key: "engine_binds", value: '{"jump":["Space"]}' },
      { v: 1, type: "storage:set", key: "engine_binds", value: null },
    ]);
  });

  it("takes the client's changes without echoing them", () => {
    const { b, sent } = bridge();
    undo = installStorageMirror(b);
    localStorage.setItem("shag_player_key", "K");
    sent.length = 0;
    b.receive({
      v: 1,
      type: "storage:changed",
      entries: { engine_cvars: '{"cl_fov":110}', shag_player_key: null, x: "y" },
    });
    expect(localStorage.getItem("engine_cvars")).toBe('{"cl_fov":110}');
    expect(localStorage.getItem("shag_player_key")).toBeNull();
    expect(localStorage.getItem("x")).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("registerNativeCvars", () => {
  it("declares what the page does not, as the client does", () => {
    Cvar.register("cl_native_test_known", 1, { type: "int" });
    const added = registerNativeCvars([
      { name: "cl_native_test_known", type: "int", default: 5 },
      { name: "r_native_test_bloom", type: "float", default: 0, min: 0, max: 3, description: "Bloom" },
      { name: "bad", type: "vector", default: 1 },
      null,
    ]);
    expect(added).toBe(1);
    expect(Cvar.isRegistered("r_native_test_bloom")).toBe(true);
    expect(Cvar.getNumber("cl_native_test_known")).toBe(1);
    Cvar.set("r_native_test_bloom", 9);
    expect(Cvar.getNumber("r_native_test_bloom")).toBe(3);
    expect(registerNativeCvars("nope")).toBe(0);
  });
});
