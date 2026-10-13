// @vitest-environment jsdom

/**
 * The leaderboard from the lobby's own rows: your position pinned when it is
 * off the board, what the next step takes, your rank in every mode, and honest
 * states when the lobby cannot say.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LobbyClient } from "../../../../lobby/LobbyClient";

vi.mock("../../../../lobby/AccountSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lobby/AccountSession")>()),
  currentIdentity: () => ({ id: "42", name: "This player" }),
}));

import { LeaderboardView, nextStep, type RankedMode } from "../LeaderboardView";
import { bindLeaderboard, type LeaderboardPage, type LeaderboardQuery } from "../NewUiApi";

type Entry = LeaderboardPage["entries"][number];

const MODES: RankedMode[] = ["duel", "amphi"].map((id) => ({
  id,
  title: id.toUpperCase(),
  accent: ["a", "b", "c", "d", "e"],
  mark: "red",
}));

const entry = (rank: number, wins: number, losses = 0, playerId = `p${rank}`, name = `Player ${rank}`): Entry => ({
  rank,
  playerId,
  name,
  wins,
  losses,
  draws: 0,
  rating: 1000 + wins * 40,
  conservativeScore: wins,
  ratedMatches: wins + losses,
  provisional: true,
});

/** Twelve ranked players, and you at #12 with a name that is markup. */
const you = entry(12, 3, 9, "42", "<img src=x onerror=alert(1)>");
const duel: Entry[] = [...Array.from({ length: 11 }, (_, i) => entry(i + 1, 20 - i)), you];

function bind(pages: Record<string, LeaderboardPage>): LeaderboardQuery[] {
  const asked: LeaderboardQuery[] = [];
  const client = {
    connected: true,
    requestLeaderboard: async (query: LeaderboardQuery) => {
      asked.push(query);
      const page = pages[`${query.gametype}:${query.scope}`] ?? pages[query.gametype] ?? { entries: [], total: 0 };
      return {
        ...page,
        system: "trueskill",
        policyVersion: "shag-trueskill-v1",
        scope: query.scope ?? "public",
        entries: page.entries.slice(0, query.limit),
      };
    },
  } as unknown as LobbyClient;
  bindLeaderboard(client, true, true);
  return asked;
}

function view(): LeaderboardView {
  const board = new LeaderboardView(MODES, document.createElement("div"));
  document.body.append(board.root, board.railMiddle);
  return board;
}

afterEach(() => {
  bindLeaderboard({ connected: false } as LobbyClient, false);
  document.body.replaceChildren();
  localStorage.clear();
});

describe("LeaderboardView", () => {
  it("pins you under the top ten with what the next step takes, and writes names as text", async () => {
    bind({ duel: { entries: duel, total: 12, localPlayerRank: 12, localPlayerEntry: you } });
    const board = view();
    await board.refresh();

    const pin = board.root.querySelector<HTMLElement>(".lb-board__foot");
    expect(pin?.hidden).toBe(false);
    expect(pin?.textContent).toContain("#12");
    expect(pin?.textContent).toContain(you.name);
    expect(pin?.textContent).toContain("320 rating points behind #10");
    expect(board.root.textContent).toContain("Career skill rating");
    expect(board.root.textContent).toContain("Provisional");
    expect(board.root.textContent).not.toContain("Most wins");
    expect(board.root.querySelector("img")).toBeNull();
    expect(board.root.querySelectorAll(".lb-plinth")).toHaveLength(3);
    // Four to ten under the podium, and the headings
    expect(board.root.querySelectorAll(".lb-podium ~ .lb-board .lb-rows .lb-row:not(.lb-row--head)")).toHaveLength(7);
  });

  it("marks a bot preset's account as a bot, on the podium and in the rows", async () => {
    const bots = duel.map((row, i) => (i === 0 || i === 4 ? { ...row, name: "Bot · Medium", bot: true } : row));
    bind({ duel: { entries: bots, total: 12 } });
    const board = view();
    await board.refresh();
    expect(board.root.querySelector(".lb-plinth--1 .lb-plinth__tag--bot")?.textContent).toBe("Bot");
    expect(board.root.querySelectorAll(".lb-row__bot")).toHaveLength(1);
    expect(board.root.querySelector(".lb-plinth--2 .lb-plinth__tag--bot")).toBeNull();
  });

  it("shows your rank in every mode in the rail, and says when you have none", async () => {
    const asked = bind({ duel: { entries: duel, total: 12, localPlayerRank: 12, localPlayerEntry: you } });
    const board = view();
    await board.refresh();

    const ranks = [...board.railMiddle.querySelectorAll(".lb-rail__rank")].map((key) => key.textContent);
    expect(ranks[0]).toContain("#12");
    expect(ranks[0]).toContain("1120");
    expect(ranks[1]).toContain("Unranked");
    // The shown mode's board carries your row; the other mode asks for one row only
    expect(asked).toEqual([
      { gametype: "duel", period: "month", offset: 0, limit: 100, scope: "public", system: "trueskill" },
      { gametype: "amphi", period: "month", offset: 0, limit: 1, scope: "public", system: "trueskill" },
    ]);
  });

  it("does not pin you twice when you are on the board", async () => {
    const top = entry(2, 19, 1, "42", "This player");
    bind({ duel: { entries: [entry(1, 20), top], total: 2, localPlayerRank: 2, localPlayerEntry: top } });
    const board = view();
    await board.refresh();
    expect(board.root.querySelector<HTMLElement>(".lb-board__foot")?.hidden).toBe(true);
    expect(board.root.querySelector(".lb-plinth.is-you")).not.toBeNull();
  });

  it("finds players in the top 100 and keeps your row pinned while it does", async () => {
    bind({ duel: { entries: duel, total: 12, localPlayerRank: 12, localPlayerEntry: you } });
    const board = view();
    await board.refresh();
    const topHundred = [...board.root.querySelectorAll<HTMLButtonElement>(".raised-key--tab")].at(-1);
    topHundred?.click();
    await Promise.resolve();

    const search = board.root.querySelector<HTMLInputElement>(".lobby__find")!;
    search.value = "nobody";
    search.dispatchEvent(new Event("input"));
    const list = board.root.querySelector(".lb-pane:not([hidden]) .lb-rows--scroll");
    expect(list?.textContent).toContain("Nobody in the top 100 goes by");
    const pins = board.root.querySelectorAll<HTMLElement>(".lb-board__foot");
    expect(pins[1]?.hidden).toBe(false);
    expect(pins[1]?.textContent).toContain("behind #11");
  });

  it("says why when the lobby cannot rank, and shows nothing it does not know", async () => {
    bindLeaderboard({ connected: true } as LobbyClient, false);
    const board = view();
    await board.refresh();
    expect(board.root.querySelector(".lb-status")?.textContent).toBe("Rankings are unavailable on this lobby server.");
    expect(board.railMiddle.textContent).toContain("Rankings are unavailable");
    expect(board.root.querySelectorAll(".lb-row:not(.lb-row--head), .lb-plinth")).toHaveLength(0);
  });

  it("tells an offline lobby from one that does not rank", async () => {
    bindLeaderboard({ connected: false } as LobbyClient, true);
    const board = view();
    await board.refresh();
    expect(board.root.querySelector(".lb-status")?.textContent).toBe(
      "The lobby server is offline. Rankings come back with it.",
    );
  });

  it("forgets the rows of a connection that is gone", async () => {
    bind({ duel: { entries: duel, total: 12, localPlayerRank: 12, localPlayerEntry: you } });
    const board = view();
    await board.refresh();
    bindLeaderboard({ connected: false } as LobbyClient, false);
    board.clear();
    expect(board.root.querySelectorAll(".lb-plinth")).toHaveLength(0);
    expect(board.root.querySelector<HTMLElement>(".lb-board__foot")?.hidden).toBe(true);
  });
});

describe("private ranking selection", () => {
  it("defaults to public, remembers the global setting, and caches boards separately", async () => {
    const asked = bind({ duel: { entries: duel, total: 12, localPlayerEntry: you } });
    const board = view();
    await board.refresh();
    const publicKey = board.root.querySelector<HTMLButtonElement>('[data-scope="public"]')!;
    const privateKey = board.root.querySelector<HTMLButtonElement>('[data-scope="private"]')!;
    expect(publicKey.getAttribute("aria-pressed")).toBe("true");
    expect(privateKey.closest(".lb-scopes")?.nextElementSibling?.className).toBe("lobby__modes");
    privateKey.click();
    await vi.waitFor(() => expect(asked.filter((query) => query.scope === "private")).toHaveLength(2));
    board.root.querySelectorAll<HTMLButtonElement>(".lobby__modes .lobby__mode-key")[1].click();
    await vi.waitFor(() => expect(asked.at(-1)).toMatchObject({ gametype: "amphi", limit: 100, scope: "private" }));
    expect(privateKey.getAttribute("aria-pressed")).toBe("true");
    await vi.waitFor(() => expect(board.root.querySelector(".lb-status")?.textContent).toContain("No ranked"));
    const before = asked.length;
    publicKey.click();
    await vi.waitFor(() => expect(asked).toHaveLength(before + 1));
    expect(asked.at(-1)).toMatchObject({ gametype: "amphi", scope: "public", limit: 100 });
    privateKey.click();
    await Promise.resolve();
    expect(asked).toHaveLength(before + 1);
    board.destroy();
    const reopened = view();
    expect(reopened.root.querySelector('[data-scope="private"]')?.getAttribute("aria-pressed")).toBe("true");
    await reopened.refresh();
    expect(asked.at(-1)?.scope).toBe("private");
  });

  it("keeps late public replies out of the private board and rail", async () => {
    const pending: Array<{ query: LeaderboardQuery; resolve: (page: LeaderboardPage) => void }> = [];
    bindLeaderboard(
      {
        connected: true,
        requestLeaderboard: (query: LeaderboardQuery) =>
          new Promise<LeaderboardPage>((resolve) => pending.push({ query, resolve })),
      } as unknown as LobbyClient,
      true,
      true,
    );
    const board = view();
    const refreshing = board.refresh();
    board.root.querySelector<HTMLButtonElement>('[data-scope="private"]')!.click();
    for (const request of pending.filter((item) => item.query.scope === "private")) {
      const row = entry(1, 9, 0, "42", "Private player");
      request.resolve({
        entries: [row],
        total: 1,
        localPlayerEntry: row,
        scope: "private",
        system: "trueskill",
        policyVersion: "shag-trueskill-v1",
      });
    }
    await vi.waitFor(() => expect(board.root.textContent).toContain("Private player"));
    for (const request of pending.filter((item) => item.query.scope === "public")) {
      request.resolve({
        entries: [you],
        total: 1,
        localPlayerEntry: you,
        scope: "public",
        system: "trueskill",
        policyVersion: "shag-trueskill-v1",
      });
    }
    await refreshing;
    expect(board.root.textContent).toContain("Private player");
    expect(board.railMiddle.textContent).toContain("1360");
    expect(board.railMiddle.textContent).not.toContain("1120");
    board.root.querySelector<HTMLButtonElement>('[data-scope="public"]')!.click();
    expect(board.root.textContent).toContain(you.name);
    expect(board.railMiddle.textContent).toContain("1120");
  });
});

describe("nextStep", () => {
  const rows = [entry(1, 10), entry(2, 8, 1), entry(3, 8, 4), entry(4, 5)];

  it("holds the top", () => {
    expect(nextStep(rows, rows[0], 10)).toBe("On top. Hold it");
  });

  it("shows only the skill gap, independent of win/loss ties", () => {
    expect(nextStep(rows, rows[3], 10)).toBe("120 rating points behind #3");
    expect(nextStep(rows, rows[2], 10)).toBe("0 rating points behind #2");
  });

  it("shows the gap to the edge of the board", () => {
    expect(nextStep(rows, entry(9, 2), 3)).toBe("240 rating points behind #3");
  });
});
