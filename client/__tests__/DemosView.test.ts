// @vitest-environment jsdom

/**
 * The demos page from what the lobby sends: featured picks as safe text under an
 * honest rule, Yours asked of the lobby rather than guessed from names, pages of
 * six, and the maps in the rail counted from the recordings themselves.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LobbyClient } from "../../../../lobby/LobbyClient";
import type { DemoInfo } from "../../../../lobby/types";
import { ago, DEMO_ARCHIVE_TIMEOUT_MS, DemosView, pageKeys, reelLengths } from "../DemosView";
import type { RankedMode } from "../LeaderboardView";
import { bindFeaturedDemos, type FeaturedDemo } from "../NewUiApi";

const MODES: RankedMode[] = ["duel", "ffa"].map((id) => ({
  id,
  title: id.toUpperCase(),
  accent: ["a", "b", "c", "d", "e"],
  mark: "red",
}));

const demo = (n: number, map: string, gametype: string, players: string[]): DemoInfo => ({
  filename: `${map}_${n}.shagdemo`,
  map,
  mapDisplayName: map.toUpperCase(),
  gametype,
  players,
  durationMs: 125_000,
  date: Date.now() - n * 60_000,
  sizeMB: 1.5,
});

function setup(options: { featured?: FeaturedDemo[]; ownership?: boolean } = {}) {
  let serial = 0;
  const requestDemoList = vi.fn(() => `archive_${++serial}`);
  const requestFeaturedDemos = vi.fn(async () => ({ entries: options.featured ?? [] }));
  const client = { connected: true, requestDemoList, requestFeaturedDemos } as unknown as LobbyClient;
  bindFeaturedDemos(client, true);
  const view = new DemosView({ client, modes: MODES, light: document.createElement("div"), leave: vi.fn() });
  document.body.append(view.root);
  view.connected(options.ownership ?? true, true);
  return { view, requestDemoList, requestFeaturedDemos };
}

const tabKey = (view: DemosView, name: string) =>
  [...view.root.querySelectorAll<HTMLButtonElement>(".raised-key--tab")].find((key) =>
    key.textContent?.includes(name),
  )!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  bindFeaturedDemos({ connected: false } as LobbyClient, false);
  document.body.replaceChildren();
});

describe("DemosView", () => {
  it("times out a missing reply, retries without reopening, and ignores superseded replies", async () => {
    vi.useFakeTimers();
    const { view, requestDemoList } = setup();
    tabKey(view, "Latest").click();
    const first = requestDemoList.mock.results.at(-1)!.value;
    await vi.advanceTimersByTimeAsync(DEMO_ARCHIVE_TIMEOUT_MS);
    expect(view.root.textContent).toContain("The archive did not answer");
    const retry = [...view.root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Try again"),
    )!;
    retry.click();
    const second = requestDemoList.mock.results.at(-1)!.value;
    expect(second).not.toBe(first);
    view.receiveList("latest", [demo(1, "wrong", "duel", ["Old"])], first);
    expect(view.root.querySelectorAll(".dm-card")).toHaveLength(0);
    view.receiveList("latest", [demo(2, "wdm2", "duel", ["Fresh"])], second);
    expect(view.root.querySelectorAll(".dm-card")).toHaveLength(1);
    expect(view.root.textContent).not.toContain("The archive did not answer");
    view.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout and refuses late data after disconnect or destruction", async () => {
    vi.useFakeTimers();
    const { view, requestDemoList } = setup();
    const first = requestDemoList.mock.results.at(-1)!.value;
    view.disconnected();
    view.receiveList("latest", [demo(1, "wdm2", "duel", ["Old"])], first);
    expect(vi.getTimerCount()).toBe(0);
    view.connected(true, true);
    const second = requestDemoList.mock.results.at(-1)!.value;
    view.destroy();
    view.receiveList("latest", [demo(2, "wdm2", "duel", ["Old"])], second);
    await vi.advanceTimersByTimeAsync(DEMO_ARCHIVE_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shows the lobby's picks as text", async () => {
    const picked = demo(1, "wdm2", "duel", ["One", "<img src=x onerror=alert(1)>"]);
    const { view } = setup({ featured: [{ demo: picked, rank: 1, reason: "Recent multiplayer recording" }] });
    await flush();

    expect(view.root.querySelector(".dm-hero")?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(view.root.querySelector("img")).toBeNull();
    expect(view.root.querySelectorAll(".raised-key--pick")).toHaveLength(1);
    view.destroy();
  });

  it("asks the lobby for Yours rather than filtering names, and only when it can prove them", () => {
    const { view, requestDemoList } = setup();
    tabKey(view, "Yours").click();
    expect(requestDemoList).toHaveBeenLastCalledWith(64, "yours");
    view.destroy();

    const unproven = setup({ ownership: false });
    expect(tabKey(unproven.view, "Yours").disabled).toBe(true);
    unproven.view.destroy();
  });

  it("keeps only the list for the board on show, in pages of six", () => {
    const { view, requestDemoList } = setup();
    tabKey(view, "Latest").click();
    view.receiveList("yours", [demo(1, "wdm2", "duel", ["Mine", "Theirs"])]);
    expect(view.root.querySelectorAll(".dm-card")).toHaveLength(0);

    const list = Array.from({ length: 8 }, (_, n) =>
      demo(n, n < 5 ? "wdm2" : "wdm7", n < 5 ? "duel" : "deathmatch", ["A", "B", "C"]),
    );
    view.receiveList("latest", list, requestDemoList.mock.results.at(-1)!.value);
    expect(view.root.querySelectorAll(".dm-card")).toHaveLength(6);

    // Deathmatch recordings are free for all
    [...view.root.querySelectorAll<HTMLButtonElement>(".lobby__mode-key")]
      .find((key) => key.textContent === "FFA")
      ?.click();
    expect(view.root.querySelectorAll(".dm-card")).toHaveLength(3);
    view.destroy();
  });

  it("says the lobby is offline instead of showing an empty archive", () => {
    const { view } = setup();
    view.disconnected();
    Object.assign((view as unknown as { host: { client: { connected: boolean } } }).host.client, { connected: false });
    tabKey(view, "Latest").click();
    expect(view.root.querySelector(".dm-grid__empty")?.textContent).toBe(
      "Lobby server offline. Connect to browse recordings.",
    );
    view.destroy();
  });

  it("leaves nothing in the document when it goes", () => {
    const { view } = setup();
    view.destroy();
    expect(document.querySelector(".dm-reel")).toBeNull();
  });
});

describe("highlight reels", () => {
  const MIN = 60_000;

  it("offers reels of at most a third of the demo", () => {
    expect(reelLengths(2 * MIN + 59_000)).toEqual([]);
    expect(reelLengths(3 * MIN)).toEqual([1]);
    expect(reelLengths(5 * MIN + 32_000)).toEqual([1]);
    expect(reelLengths(6 * MIN)).toEqual([1, 2]);
    expect(reelLengths(8 * MIN + 59_000)).toEqual([1, 2]);
    expect(reelLengths(9 * MIN)).toEqual([1, 2, 3]);
    expect(reelLengths(60 * MIN)).toEqual([1, 2, 3]);
  });

  it("offers reel lengths in the dialog and video export on the arrow, short demos disabled", () => {
    vi.stubEnv("DEV", false);
    const { view, requestDemoList } = setup();
    tabKey(view, "Latest").click();
    const short = demo(1, "wdm2", "duel", ["A", "B"]);
    const long = { ...demo(2, "wdm2", "duel", ["C", "D"]), durationMs: 5 * MIN + 32_000 };
    view.receiveList("latest", [short, long], requestDemoList.mock.results.at(-1)!.value);
    const keys = [...view.root.querySelectorAll<HTMLButtonElement>('.dm-card [aria-label="Highlights"]')];
    expect(keys).toHaveLength(2);
    const [shortKey, longKey] = keys;
    expect(shortKey.disabled).toBe(true);
    expect(shortKey.title).toBe("Too short for a highlight reel");
    expect(shortKey.hasAttribute("data-demo-play")).toBe(false);
    expect(longKey.disabled).toBe(false);

    longKey.click();
    const options = [...document.querySelectorAll<HTMLButtonElement>(".dm-reel__opt")];
    expect(options.map((option) => option.textContent)).toEqual(["1min", "2min", "3min"]);
    expect(options.map((option) => option.disabled)).toEqual([false, true, true]);

    // Export video is on the arrow beside Highlights, which a short demo has disabled too
    const arrows = [...view.root.querySelectorAll<HTMLButtonElement>(".dm-card .dm-hl__arrow")];
    expect(arrows.map((arrow) => arrow.disabled)).toEqual([true, false]);
    arrows[1].click();
    expect([...document.querySelectorAll(".dm-hl-menu__item")].map((item) => item.textContent)).toEqual([
      "Export video",
    ]);
    // Opening the menu closes the reel dialog
    expect(document.querySelector<HTMLElement>(".dm-reel")?.hidden).toBe(true);
    view.destroy();
  });
});

describe("pages and times", () => {
  it("keys every page when few, else the ends and the neighbours", () => {
    expect(pageKeys(2, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageKeys(6, 11)).toEqual([1, 2, 5, 6, 7, 10, 11]);
  });

  it("says how long ago in as few words as fit", () => {
    const now = Date.UTC(2026, 8, 25, 12);
    expect(ago(now - 5 * 60_000, true, now)).toBe("5m ago");
    expect(ago(now - 3 * 3_600_000, false, now)).toBe("3 h ago");
    expect(ago(now - 2 * 86_400_000, true, now)).toBe("2d ago");
    expect(ago(now - 86_400_000, false, now)).toBe("Yesterday");
  });
});
