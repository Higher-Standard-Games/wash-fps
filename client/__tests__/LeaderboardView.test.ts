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

import { RATING_POLICY } from "../../../../shared/ranking/RatingPolicy";
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
      const page = pages[query.gametype] ?? { entries: [], total: 0 };
      return {
        ...page,
        system: "trueskill",
        policyVersion: RATING_POLICY.version,
        scope: query.scope ?? "overall",
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
      { gametype: "duel", period: "month", offset: 0, limit: 100, system: "trueskill" },
      { gametype: "amphi", period: "month", offset: 0, limit: 1, system: "trueskill" },
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

describe("one board", () => {
  it("reads the Overall ranking with no Public/Private switch", async () => {
    const asked = bind({ duel: { entries: duel, total: 12, localPlayerEntry: you } });
    const board = view();
    await board.refresh();
    expect(board.root.querySelector("[data-scope], .lb-scopes")).toBeNull();
    expect(board.root.querySelector(".lobby__kicker")?.textContent).toBe("Leaderboard · DUEL");
    expect(asked.every((query) => query.scope === undefined)).toBe(true);
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
