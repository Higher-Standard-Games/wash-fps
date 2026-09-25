// @vitest-environment jsdom

/**
 * The demos page from what the lobby sends: featured picks as safe text under an
 * honest rule, Yours asked of the lobby rather than guessed from names, pages of
 * six, and the maps in the rail counted from the recordings themselves.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LobbyClient } from "../../../../lobby/LobbyClient";
import type { DemoInfo } from "../../../../lobby/types";
import { ago, DemosView, pageKeys } from "../DemosView";
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
  const requestDemoList = vi.fn();
  const requestFeaturedDemos = vi.fn(async () => ({ entries: options.featured ?? [] }));
  const client = { connected: true, requestDemoList, requestFeaturedDemos } as unknown as LobbyClient;
  bindFeaturedDemos(client, true);
  const view = new DemosView({ client, modes: MODES, light: document.createElement("div"), leave: vi.fn() });
  document.body.append(view.root, view.railMiddle);
  view.connected(options.ownership ?? true, true);
  return { view, requestDemoList, requestFeaturedDemos };
}

const tabKey = (view: DemosView, name: string) =>
  [...view.root.querySelectorAll<HTMLButtonElement>(".raised-key--tab")].find((key) =>
    key.textContent?.includes(name),
  )!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  bindFeaturedDemos({ connected: false } as LobbyClient, false);
  document.body.replaceChildren();
});

describe("DemosView", () => {
  it("shows the lobby's picks as text, under a rule that says how they were chosen", async () => {
    const picked = demo(1, "wdm2", "duel", ["One", "<img src=x onerror=alert(1)>"]);
    const { view } = setup({ featured: [{ demo: picked, rank: 1, reason: "Recent multiplayer recording" }] });
    await flush();

    expect(view.root.querySelector(".lobby__rule")?.textContent).toBe(
      "No top-10 matches this week · the latest multiplayer matches instead",
    );
    expect(view.root.querySelector(".dm-hero")?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(view.root.querySelector("img")).toBeNull();
    expect(view.root.querySelectorAll(".raised-key--pick")).toHaveLength(1);
    view.destroy();
  });

  it("names the top ten when the lobby picked for it", async () => {
    const picked = demo(1, "wdm2", "duel", ["One", "Two"]);
    const { view } = setup({ featured: [{ demo: picked, rank: 1, reason: "Features a 30-day top 10 player" }] });
    await flush();
    expect(view.root.querySelector(".lobby__rule")?.textContent).toBe(
      "This week's matches with players from the 30-day top 10",
    );
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
    const { view } = setup();
    tabKey(view, "Latest").click();
    view.receiveList("yours", [demo(1, "wdm2", "duel", ["Mine", "Theirs"])]);
    expect(view.root.querySelectorAll(".dm-card")).toHaveLength(0);

    const list = Array.from({ length: 8 }, (_, n) =>
      demo(n, n < 5 ? "wdm2" : "wdm7", n < 5 ? "duel" : "deathmatch", ["A", "B", "C"]),
    );
    view.receiveList("latest", list);
    expect(view.root.querySelectorAll(".dm-card")).toHaveLength(6);
    expect(view.root.querySelector(".dm-count")?.textContent).toBe("8demos · page 1 of 2");

    // Deathmatch recordings are free for all; the rail counts each map's recordings
    [...view.root.querySelectorAll<HTMLButtonElement>(".lobby__mode-key")]
      .find((key) => key.textContent === "FFA")
      ?.click();
    expect(view.root.querySelectorAll(".dm-card")).toHaveLength(3);
    const maps = [...view.railMiddle.querySelectorAll(".dm-rail__map")].map((key) => key.getAttribute("aria-label"));
    expect(maps).toEqual(["All maps: 3 recordings", "WDM7: 3 recordings"]);
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
