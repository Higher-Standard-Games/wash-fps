// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LobbyClient } from "../../../../lobby/LobbyClient";

vi.mock("../../../../lobby/AccountSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lobby/AccountSession")>()),
  currentIdentity: () => ({ id: "42", name: "This player" }),
}));

import { LobbyPanel } from "../LobbyPanel";
import { bindLeaderboard, type LeaderboardPage } from "../NewUiApi";

const localPlayerEntry = {
  rank: 101,
  playerId: "42",
  name: "<img src=x onerror=alert(1)>",
  wins: 7,
  losses: 9,
  draws: 2,
};

function panelWith(page: LeaderboardPage | null) {
  const panel = Object.create(LobbyPanel.prototype) as {
    leaderboardBody: HTMLElement;
    leaderboardPin: HTMLElement;
    leaderboardStatus: HTMLElement;
    leaderboardPage: LeaderboardPage | null;
    leaderboardPeriod: "month";
    leaderboardSearch: string;
    renderLeaderboard: () => void;
  };
  Object.assign(panel, {
    leaderboardBody: document.createElement("div"),
    leaderboardPin: document.createElement("aside"),
    leaderboardStatus: document.createElement("p"),
    leaderboardPage: page,
    leaderboardPeriod: "month",
    leaderboardSearch: "",
  });
  return panel;
}

afterEach(() => bindLeaderboard({ connected: false } as LobbyClient, false));

describe("leaderboard pinned position", () => {
  it("keeps an authenticated row outside the top page visible during search and renders its name safely", () => {
    bindLeaderboard({ connected: true } as LobbyClient, true);
    const panel = panelWith({
      entries: [{ rank: 1, playerId: "1", name: "Leader", wins: 10, losses: 0, draws: 0 }],
      total: 101,
      localPlayerRank: 101,
      localPlayerEntry,
    });
    panel.renderLeaderboard();
    expect(panel.leaderboardPin.hidden).toBe(false);
    expect(panel.leaderboardPin.textContent).toContain("#101");
    expect(panel.leaderboardPin.textContent).toContain(localPlayerEntry.name);
    expect(panel.leaderboardPin.querySelector("img")).toBeNull();

    panel.leaderboardSearch = "unmatched";
    panel.renderLeaderboard();
    expect(panel.leaderboardBody.textContent).toContain("No player in the top 100 matches");
    expect(panel.leaderboardPin.textContent).toContain("#101");
  });

  it("avoids a duplicate near the top and clears the pin when rankings are unavailable", () => {
    bindLeaderboard({ connected: true } as LobbyClient, true);
    const topEntry = { ...localPlayerEntry, rank: 1 };
    const panel = panelWith({ entries: [topEntry], total: 1, localPlayerEntry: topEntry });
    panel.renderLeaderboard();
    expect(panel.leaderboardPin.hidden).toBe(true);
    bindLeaderboard({ connected: false } as LobbyClient, false);
    panel.renderLeaderboard();
    expect(panel.leaderboardPin.hidden).toBe(true);
    expect(panel.leaderboardPin.childElementCount).toBe(0);
  });
});
