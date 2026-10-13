// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LobbyClient } from "../../../../lobby/LobbyClient";
import type { DemoInfo } from "../../../../lobby/types";

const service = vi.hoisted(() => ({
  fetchAndLoad: vi.fn(),
  loadAndPlayNormal: vi.fn(),
  setExitHandler: vi.fn(),
  loadAndPlayCinematic: vi.fn(),
}));
vi.mock("../DemoService", () => ({ DemoService: { getInstance: () => service } }));
vi.mock("../DemoViewer", () => ({ DemoViewer: class {} }));

import { DemosView } from "../DemosView";
import { bindFeaturedDemos } from "../NewUiApi";

const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
const recordings: DemoInfo[] = ["wdm2", "wdm7"].map((map) => ({
  filename: `${map}.shagdemo`,
  map,
  mapDisplayName: map.toUpperCase(),
  gametype: "ffa",
  players: ["One", "Two"],
  durationMs: 1000,
  date: Date.now(),
  sizeMB: 1,
}));
let view: DemosView;
function setup() {
  service.loadAndPlayNormal.mockResolvedValue(undefined);
  service.loadAndPlayCinematic.mockResolvedValue(undefined);
  const client = {
    connected: true,
    requestDemoList: () => "listing",
    requestFeaturedDemos: async () => ({ entries: [] }),
  } as unknown as LobbyClient;
  bindFeaturedDemos(client, true);
  const leave = vi.fn(() => view.deactivate());
  const show = vi.fn();
  view = new DemosView({ client, modes: [], light: document.createElement("div"), leave, show });
  document.body.append(view.root);
  view.connected(true, true);
  [...view.root.querySelectorAll<HTMLButtonElement>(".raised-key--tab")]
    .find((key) => key.textContent?.includes("Latest"))!
    .click();
  view.receiveList("latest", recordings, "listing");
  const watch = () =>
    [...view.root.querySelectorAll<HTMLButtonElement>("[data-demo-play]")].filter((key) =>
      key.textContent?.includes("Watch"),
    );
  const transferKey = () => view.root.querySelector<HTMLButtonElement>(".dm-transfer button")!;
  return { watch, transferKey, leave, show };
}
afterEach(() => {
  view?.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetAllMocks();
  bindFeaturedDemos({ connected: false } as LobbyClient, false);
  document.body.replaceChildren();
});

describe("demo selection transfer", () => {
  it("clears loading feedback when another service operation cancels the file load", async () => {
    service.fetchAndLoad.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    const ui = setup();
    ui.watch()[0].click();
    await flush();
    expect(view.root.querySelector<HTMLElement>(".dm-transfer")!.hidden).toBe(true);
    expect(view.root.hasAttribute("aria-busy")).toBe(false);
    expect(ui.watch().every((key) => !key.disabled)).toBe(true);
    expect(service.loadAndPlayNormal).not.toHaveBeenCalled();
    expect(ui.leave).not.toHaveBeenCalled();
  });
  it("serializes selections, and cancelling A permits B without late A playback", async () => {
    const pending: Array<{ resolve: () => void; signal: AbortSignal }> = [];
    service.fetchAndLoad.mockImplementation(
      (_file, options) => new Promise<void>((resolve) => pending.push({ resolve, signal: options.signal })),
    );
    const ui = setup();
    const [a, b] = ui.watch();
    a.click();
    expect(view.root.getAttribute("aria-busy")).toBe("true");
    expect(b.disabled).toBe(true);
    b.click();
    expect(service.fetchAndLoad).toHaveBeenCalledTimes(1);
    // Re-rendered cards must remain disabled too.
    const search = view.root.querySelector<HTMLInputElement>("input")!;
    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(ui.watch().every((key) => key.disabled)).toBe(true);
    ui.transferKey().click();
    expect(pending[0].signal.aborted).toBe(true);
    expect(view.root.hasAttribute("aria-busy")).toBe(false);
    const next = ui.watch()[1];
    expect(next.disabled).toBe(false);
    next.click();
    pending[1].resolve();
    await flush();
    pending[0].resolve();
    await flush();
    expect(service.loadAndPlayNormal).toHaveBeenCalledOnce();
    expect(ui.leave).toHaveBeenCalledOnce();
    expect(ui.show).not.toHaveBeenCalled();
    expect(view.root.querySelector<HTMLElement>(".dm-transfer")!.hidden).toBe(true);
  });

  it.each(["deactivate", "disconnected", "destroy"] as const)("prevents delayed playback after %s", async (action) => {
    let complete!: () => void;
    let signal!: AbortSignal;
    service.fetchAndLoad.mockImplementation((_file, options) => {
      signal = options.signal;
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    });
    const ui = setup();
    ui.watch()[0].click();
    view[action]();
    expect(signal.aborted).toBe(true);
    complete();
    await flush();
    expect(service.loadAndPlayNormal).not.toHaveBeenCalled();
    expect(ui.leave).not.toHaveBeenCalled();
  });

  it("keeps a useful timeout message and retries without reopening the page", async () => {
    service.fetchAndLoad
      .mockRejectedValueOnce(new Error("The demo download stalled. Please try again."))
      .mockResolvedValue(undefined);
    const ui = setup();
    ui.watch()[0].click();
    await flush();
    expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("stalled");
    expect(ui.transferKey().textContent).toContain("Try again");
    expect(ui.watch().every((key) => !key.disabled)).toBe(true);
    ui.transferKey().click();
    await flush();
    expect(service.fetchAndLoad).toHaveBeenCalledTimes(2);
    expect(service.loadAndPlayNormal).toHaveBeenCalledOnce();
    expect(ui.leave).toHaveBeenCalledOnce();
  });

  it("hides only after file validation and allows the deliberate map handoff", async () => {
    let complete!: () => void;
    service.fetchAndLoad.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const ui = setup();
    service.loadAndPlayNormal.mockImplementation(async () => {
      expect(ui.leave).toHaveBeenCalledOnce();
      expect(view.root.hasAttribute("aria-busy")).toBe(false);
    });
    ui.watch()[0].click();
    expect(ui.leave).not.toHaveBeenCalled();
    complete();
    await flush();
    expect(service.loadAndPlayNormal).toHaveBeenCalledOnce();
    expect(ui.show).not.toHaveBeenCalled();
    // Leaving playback later comes back to this page.
    const exit = service.setExitHandler.mock.calls.at(-1)?.[0] as () => void;
    exit();
    expect(ui.show).toHaveBeenCalledOnce();
  });

  it("restores the menu and Retry when playback startup fails", async () => {
    service.fetchAndLoad.mockResolvedValue(undefined);
    service.loadAndPlayNormal.mockRejectedValue(new Error("Demo map load failed"));
    const ui = setup();
    // setup sets normal success; inject the failure afterward.
    service.loadAndPlayNormal.mockRejectedValueOnce(new Error("Demo map load failed"));
    ui.watch()[0].click();
    await flush();
    expect(ui.leave).toHaveBeenCalledOnce();
    expect(ui.show).toHaveBeenCalledOnce();
    expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("map load failed");
    expect(ui.transferKey().textContent).toContain("Try again");
  });
});
