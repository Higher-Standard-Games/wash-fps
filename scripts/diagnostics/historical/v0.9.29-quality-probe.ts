/**
 * Release-audit probes: verify input, preferences and demo selection fixes.
 * Run: npm exec -- vite-node src/games/fps/scripts/diagnostics/historical/v0.9.29-quality-probe.ts
 * No server, assets, browser, or persistent writes.
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { InputSystem } from "../../../../../engine/input/InputSystem";
import { Cvar } from "../../../../../engine/core/Cvar";
import { UITheme } from "../../../../../engine/ui/UITheme";
import { FPS, registerFPSActions } from "../../../client/FPSActions";

const dom = new JSDOM("<!doctype html><html><head></head><body><canvas></canvas></body></html>", {
  url: "https://quality-probe.invalid",
});
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
const storage = dom.window.localStorage;
const findings: Record<string, unknown> = {};

const engine = new NullEngine();
const scene = new Scene(engine);
const canvas = document.querySelector("canvas")!;
const input = InputSystem.getInstance();
input.init(scene, canvas);
registerFPSActions();
const frame = () => {
  scene.onBeforeRenderObservable.notifyObservers(scene);
  scene.onAfterRenderObservable.notifyObservers(scene);
};
try {
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "KeyW" }));
  frame();
  assert.equal(input.isActive(FPS.MOVE_FORWARD), true);
  dom.window.dispatchEvent(new dom.window.Event("blur"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
  frame();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
  frame();
  assert.equal(input.isActive(FPS.MOVE_FORWARD), false);
  findings.heldKeyAfterFocusLoss = { rawW: input.isKeyDown("KeyW"), forwardAction: input.isActive(FPS.MOVE_FORWARD) };
  document.dispatchEvent(new dom.window.KeyboardEvent("keyup", { code: "KeyW" }));

  canvas.dispatchEvent(new dom.window.MouseEvent("mousedown", { button: 0 }));
  document.dispatchEvent(new dom.window.MouseEvent("mouseup", { button: 0 }));
  frame();
  assert.equal(input.isActive(FPS.FIRE), false);
  findings.mouseReleaseOutsideCanvas = { fireAction: input.isActive(FPS.FIRE) };
  canvas.dispatchEvent(new dom.window.MouseEvent("mouseup", { button: 0 }));
  frame();

  // Syntactically valid JSON; catch(JSON.parse) cannot validate this shape.
  storage.setItem("shag_keybindings", JSON.stringify({ [FPS.MOVE_FORWARD]: { key: "KeyW" } }));
  input.loadBindingsFromStorage();
  assert.doesNotThrow(() => Reflect.get(input, "updateActionStates").call(input));
  assert.deepEqual(input.getBindingsForAction(FPS.MOVE_FORWARD), [{ key: "KeyW" }]);
  findings.malformedBindings = "Invalid override ignored; default W binding remains usable";
  input.resetAllBindings();
} finally {
  input.dispose();
  scene.dispose();
  engine.dispose();
}

try {
  Object.assign(globalThis, { localStorage: { getItem: () => { throw new Error("Storage access denied"); } } });
  assert.equal(UITheme.getInstance().getMode(), "light");
  findings.themeReadFailure = "Default light theme initialized despite denied storage";
  Object.assign(globalThis, { localStorage: storage });
  const theme = UITheme.getInstance();
  theme.init();
  const before = document.head.innerHTML;
  let notified = false;
  const unsub = theme.onModeChange(() => { notified = true; });
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => { throw new Error("Storage quota exceeded"); } } });
  theme.setMode("dark");
  findings.themeWriteFailure = { mode: theme.getMode(), stylesChanged: before !== document.head.innerHTML, notified };
  assert.equal(theme.getMode(), "dark");
  assert.notEqual(before, document.head.innerHTML);
  assert.equal(notified, true);
  unsub();
} finally {
  Object.assign(globalThis, { localStorage: storage });
}

storage.setItem("engine_cvars", JSON.stringify({ s_musicenabled: null }));
Cvar.init();
assert.doesNotThrow(() => Cvar.register("s_musicenabled", true, { type: "bool" }));
assert.equal(Cvar.getBool("s_musicenabled"), true);
findings.malformedCvar = "Invalid stored value ignored; declared boolean default remains usable";

// Actual fetchAndLoad + parser + DemosView.run; mock only the transport and
// playback callback. Synthetic recordings are built in memory by the server's
// own encoder; no map loading, renderer, real sessions, or demo files involved.
const { DemoService } = await import("../../../client/DemoService");
const { DemosView } = await import("../../../client/DemosView");
const { DemoRecorder } = await import("../../../server/DemoRecorder");
const { GameState } = await import("../../../../../engine/network/core/GameState");
function recording(map: string): Uint8Array<ArrayBuffer> {
  const recorder = new DemoRecorder({ map, gametype: "ffa", tickRate: 125, snapshotRate: 60 });
  const state = new GameState();
  state.tick = 1;
  recorder.recordFrame(state);
  return new Uint8Array(Reflect.get(recorder, "_buildDemoBuffer").call(recorder, 1000));
}
const responses = new Map<string, (response: Response) => void>();
const requestOptions: Array<RequestInit | undefined> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  requestOptions.push(options);
  return new Promise<Response>((resolve) => responses.set(String(url).split("/").pop()!, resolve));
};
try {
  let left = 0;
  const view = new DemosView({
    client: { connected: false } as never, modes: [], light: document.createElement("div"),
    leave: () => { left++; view.deactivate(); },
  });
  const played: string[] = [];
  const key = () => {
    const button = document.createElement("button");
    button.innerHTML = '<span class="raised-key__label">Watch</span>';
    return button;
  };
  const aKey = key();
  const bKey = key();
  const start = async (service: InstanceType<typeof DemoService>) => {
    played.push(service.loadedDemoReader!.readHeader().map);
  };
  aKey.dataset.demoPlay = bKey.dataset.demoPlay = "true";
  view.root.append(aKey, bKey);
  const run = Reflect.get(view, "run").bind(view);
  const a = run({ filename: "a.shagdemo", map: "wdm2" }, document.createElement("div"), aKey, start);
  await run({ filename: "b.shagdemo", map: "wdm7" }, document.createElement("div"), bKey, start);
  assert.equal(aKey.disabled && bKey.disabled, true);
  assert.equal(responses.has("b.shagdemo"), false);
  view.deactivate();
  const b = run({ filename: "b.shagdemo", map: "wdm7" }, document.createElement("div"), bKey, start);
  responses.get("b.shagdemo")!(new Response(recording("wdm7")));
  await b;
  responses.get("a.shagdemo")!(new Response(recording("wdm2")));
  await a;
  assert.deepEqual(played, ["wdm7"]);
  assert.equal(left, 1);
  assert.equal(requestOptions.every((options) => Boolean(options?.signal)), true);
  findings.demoDownloads = { cancelledAThenBPlayback: played, menuLeaveCalls: left, abortSignals: requestOptions.map((options) => Boolean(options?.signal)) };
  view.destroy();
} finally {
  globalThis.fetch = originalFetch;
  dom.window.close();
}
console.log("QUALITY_AUDIT_FINDINGS=" + JSON.stringify(findings, null, 2));
