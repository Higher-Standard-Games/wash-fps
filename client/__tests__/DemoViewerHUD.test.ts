// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoViewerInfo } from "../DemoViewer";
import { DemoViewerHUD } from "../DemoViewerHUD";

const info = (state: DemoViewerInfo["state"]): DemoViewerInfo =>
  ({
    state,
    currentFrame: 5,
    totalFrames: 11,
    elapsedMs: 65_000,
    durationMs: 275_000,
    playbackSpeed: 1,
  }) as DemoViewerInfo;

let now = 0;
beforeEach(() => {
  document.body.innerHTML = "";
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

const bar = () => document.querySelector<HTMLElement>("#demo-viewer-hud");

describe("DemoViewerHUD", () => {
  it("fades while a demo plays untouched, and comes back on a move, a pause or a hover", () => {
    const hud = new DemoViewerHUD();
    hud.update(info("playing"));
    expect(bar()?.classList.contains("is-idle")).toBe(false);

    now = 3000;
    hud.update(info("playing"));
    expect(bar()?.classList.contains("is-idle")).toBe(true);

    document.dispatchEvent(new MouseEvent("mousemove"));
    hud.update(info("playing"));
    expect(bar()?.classList.contains("is-idle")).toBe(false);

    now = 9000;
    hud.update(info("paused"));
    expect(bar()?.classList.contains("is-idle")).toBe(false);

    bar()?.dispatchEvent(new MouseEvent("mouseenter"));
    hud.update(info("playing"));
    expect(bar()?.classList.contains("is-idle")).toBe(false);
    hud.dispose();
  });

  it("shows the time and the followed player in gold, and picks another", () => {
    const hud = new DemoViewerHUD();
    const picked = vi.fn();
    hud.onPlayerSelect(picked);
    hud.setPlayerList([
      { entityId: "player_1", name: "Alice", isTarget: true },
      { entityId: "player_2", name: "Bob", isTarget: false },
    ]);
    hud.update(info("playing"));
    expect(bar()?.querySelector(".dvh-time")?.textContent).toBe("1:05 / 4:35");

    const chips = [...(bar()?.querySelectorAll<HTMLButtonElement>(".dvh-player") ?? [])];
    expect(chips.map((chip) => chip.classList.contains("is-target"))).toEqual([true, false]);
    chips[1].click();
    expect(picked).toHaveBeenCalledWith("player_2");
    hud.dispose();
  });

  it("switches the game HUD and shows whether it is on", () => {
    const hud = new DemoViewerHUD();
    const toggled = vi.fn();
    hud.onHudToggle(toggled);
    const button = [...(bar()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "HUD");
    expect(button?.classList.contains("is-on")).toBe(true);

    button?.click();
    expect(toggled).toHaveBeenCalledOnce();
    hud.setGameHudVisible(false);
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    hud.dispose();
  });

  it("leaves playback from the exit plate or Esc, but not from Esc in a text field", () => {
    const hud = new DemoViewerHUD();
    const exit = vi.fn();
    hud.onExit(exit);
    document.querySelector<HTMLButtonElement>("#demo-viewer-exit")?.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    expect(exit).toHaveBeenCalledTimes(2);
    const input = document.body.appendChild(document.createElement("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true }));
    expect(exit).toHaveBeenCalledTimes(2);
    hud.dispose();
  });

  it("shows a reel by its shots: a tick per shot, the shot count, previous and next", () => {
    const hud = new DemoViewerHUD();
    const next = vi.fn();
    hud.onNext(next);
    hud.setReel([0, 0.4, 0.7]);
    expect(bar()?.classList.contains("is-reel")).toBe(true);
    expect(bar()?.querySelectorAll(".dvh-mark")).toHaveLength(3);
    hud.updateReel({
      state: "playing",
      progress: 0.5,
      elapsedMs: 30_000,
      totalMs: 60_000,
      segment: 1,
      segments: 3,
      isReplay: true,
      speed: 0.25,
    });
    expect(bar()?.querySelector(".dvh-shot")?.textContent).toBe("Replay 2/3 · 0.25x");
    expect(bar()?.querySelector(".dvh-time")?.textContent).toBe("0:30 / 1:00");
    [...(bar()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "▶▶")?.click();
    expect(next).toHaveBeenCalledOnce();
    hud.dispose();
  });

  it("minimizes to a strip and comes back", () => {
    const hud = new DemoViewerHUD();
    const toggle = bar()?.querySelector<HTMLButtonElement>(".dvh-minimize");
    toggle?.click();
    expect(hud.isMinimized()).toBe(true);
    expect(bar()?.classList.contains("is-min")).toBe(true);
    toggle?.click();
    expect(bar()?.classList.contains("is-min")).toBe(false);
    hud.dispose();
  });

  it("fades in Replay and Exit once a reel has ended, and takes them away when it plays on", () => {
    const hud = new DemoViewerHUD();
    const replay = vi.fn();
    const exit = vi.fn();
    hud.onReplay(replay);
    hud.onExit(exit);
    const keys = document.querySelector<HTMLElement>("#demo-viewer-end")!;
    expect(keys.classList.contains("is-shown")).toBe(false);

    hud.setReelEnded(true);
    expect(keys.classList.contains("is-shown")).toBe(true);
    keys.querySelector<HTMLButtonElement>(".dvh-end-replay")!.click();
    keys.querySelector<HTMLButtonElement>(".dvh-end-exit")!.click();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);

    hud.setReelEnded(false);
    expect(keys.classList.contains("is-shown")).toBe(false);
    hud.dispose();
    expect(document.querySelector("#demo-viewer-end")).toBeNull();
  });

  it("shows a reel's title card while asked, and its end card with the keys", () => {
    const hud = new DemoViewerHUD();
    hud.setTitle({
      mode: "Duel",
      map: "Campgrounds",
      sides: [{ names: ["Ann"] }, { names: ["Bo"] }],
      more: 0,
    });
    const title = document.querySelector<HTMLElement>("#demo-viewer-title")!;
    expect(title.textContent).toBe("DuelCampgroundsAnnvsBo");
    hud.setTitleVisible(true);
    expect(title.classList.contains("is-shown")).toBe(true);
    hud.setTitleVisible(false);
    expect(title.classList.contains("is-shown")).toBe(false);

    hud.setEndCard({
      topFragger: { name: "Ann", frags: 1 },
      best: { title: "Frag", player: "Ann" },
      frags: 3,
      tricks: 0,
    });
    const end = document.querySelector<HTMLElement>("#demo-viewer-end")!;
    expect(end.textContent).toContain("Top fragger");
    expect(end.textContent).toContain("Ann · 1 frag");
    expect(end.textContent).toContain("Best momentFrag · Ann");
    expect(end.textContent).toContain("3 highlights");
    expect(end.textContent).not.toContain("trick");
    hud.dispose();
  });

  it("clears the picture of controls and the pointer in the clean view, and brings them back", () => {
    const hud = new DemoViewerHUD();
    hud.hide();
    expect(bar()!.style.display).toBe("none");
    expect(document.body.classList.contains("dvh-clean")).toBe(true);
    hud.show();
    expect(document.body.classList.contains("dvh-clean")).toBe(false);
    hud.hide();
    hud.dispose();
    expect(document.body.classList.contains("dvh-clean")).toBe(false);
  });

  it("shows a shot's card", () => {
    const hud = new DemoViewerHUD();
    hud.showCard({ kicker: "Highlight 1/3", title: "Frag", player: "Ramen → Gyoza", detail: "rocket", tags: ["Air"] });
    const card = document.querySelector("#demo-viewer-card");
    expect(card?.classList.contains("is-shown")).toBe(true);
    expect(card?.textContent).toContain("Ramen → Gyoza");
    hud.dispose();
    expect(document.querySelector("#demo-viewer-card")).toBeNull();
  });

  it("takes its styles with it", () => {
    const hud = new DemoViewerHUD();
    expect(document.querySelector("style#ui-styles-demo-viewer-hud")).not.toBeNull();
    hud.hide();
    expect(bar()?.style.display).toBe("none");
    hud.dispose();
    expect(bar()).toBeNull();
    expect(document.querySelector("style#ui-styles-demo-viewer-hud")).toBeNull();
  });
});
