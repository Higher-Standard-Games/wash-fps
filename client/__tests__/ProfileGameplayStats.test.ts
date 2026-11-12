// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryPage, StatsQuery, StatsSummary } from "../../../../lobby/PlayerStatsStore";
import { matchStats } from "../../../../shared/ranking/__tests__/_matchStats";
import { bindLeaderboard, bindPlayerStats, newUiApi } from "../NewUiApi";
import { ProfileView } from "../ProfileView";

let view: ProfileView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  bindPlayerStats({ connected: false } as never, false);
  bindLeaderboard({ connected: false } as never, false);
});
function summary(query: StatsQuery): StatsSummary {
  const { version: _version, ...totals } = matchStats();
  return {
    ...query,
    matches: 3,
    wins: 2,
    losses: 1,
    draws: 0,
    statsMatches: 3,
    totals,
    rating: null,
    excluded: 3,
  };
}
function setup() {
  const client = {
    connected: true,
    on: () => () => {},
    requestPlayerStats: vi.fn(async (query: StatsQuery) => summary(query)),
    requestMatchHistory: vi.fn(
      async (query: Pick<StatsQuery, "gametype" | "scope">): Promise<HistoryPage> => ({
        ...query,
        entries: [
          {
            sequence: 2,
            matchId: "m-2",
            map: "wdm2",
            gametype: query.gametype,
            scope: "private",
            startedAt: 1000,
            endedAt: 2000,
            completion: "normal",
            outcome: "win",
            score: 3,
            stats: matchStats(),
            recordStatus: "recorded",
            recordReason: "eligible",
            ratingStatus: "applied",
            ratingReason: "eligible",
            ratingChange: { before: 1000, after: 1020, delta: 20 },
          },
        ],
        nextBeforeSequence: null,
      }),
    ),
  };
  bindPlayerStats(client as never, true);
  bindLeaderboard(client as never, false);
  view = new ProfileView({
    client: client as never,
    isInRoom: () => false,
    modes: () => [{ id: "duel", name: "DUEL", description: "", maxPlayers: 2, hasTeams: true, mapPool: [] }],
  });
  return { client, view };
}
describe("profile gameplay stats", () => {
  it("shows records and gameplay totals without a rating, then the committed rating change in history", async () => {
    const { view, client } = setup();
    await view.refreshRecord();
    expect(view.root.querySelector(".profile-record__row")?.textContent).toContain("Not rated2 W1 L");
    expect(view.root.querySelector(".profile-stats__detail")?.textContent).toContain("4 frags");
    expect(view.root.querySelector(".profile-record__status")?.textContent).toContain("3 not rated");
    view.root.querySelector<HTMLButtonElement>(".profile-record__history-key")!.click();
    await vi.waitFor(() =>
      expect(view.root.querySelector(".profile-history")?.textContent).toContain("1000 → 1020 (+20)"),
    );
    expect(client.requestMatchHistory).toHaveBeenCalledWith({
      gametype: "duel",
      scope: "overall",
      limit: 10,
      beforeSequence: undefined,
    });
  });
  it("reads one Overall record with no Public/Private switch", async () => {
    const { view, client } = setup();
    await view.refreshRecord();
    expect(client.requestPlayerStats).toHaveBeenCalledWith({ gametype: "duel", scope: "overall", period: "all" });
    expect(view.root.querySelector("[aria-label='Ranking scope']")).toBeNull();
    expect(view.root.querySelector(".profile-record__status")?.textContent).toMatch(/^3 matches/);
  });
  it("refuses malformed stats rather than rendering invented totals", async () => {
    const { client } = setup();
    client.requestPlayerStats.mockResolvedValueOnce({
      ...summary({ gametype: "duel", scope: "public", period: "all" }),
      matches: 100,
    });
    expect(await newUiApi.getPlayerStats({ gametype: "duel", scope: "public", period: "all" })).toMatchObject({
      status: "unavailable",
    });
  });
});
