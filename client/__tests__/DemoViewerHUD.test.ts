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
