import { afterEach, describe, expect, it, vi } from "vitest";
import type { LobbyClient } from "../../../../lobby/LobbyClient";
import { bindFeaturedDemos, bindLeaderboard, newUiApi } from "../NewUiApi";

afterEach(() => {
  bindLeaderboard({ connected: false } as LobbyClient, false);
  bindFeaturedDemos({ connected: false } as LobbyClient, false);
});

describe("leaderboard UI adapter", () => {
  it("refuses missing or mismatched scopes instead of relabelling public results as private", async () => {
    const requestLeaderboard = vi.fn().mockResolvedValue({ entries: [], total: 0 });
    bindLeaderboard({ connected: true, requestLeaderboard } as unknown as LobbyClient, true, true);
    const query = { gametype: "duel", period: "all" as const, offset: 0, limit: 10, scope: "private" as const };
    expect(await newUiApi.getLeaderboard(query)).toMatchObject({ status: "unavailable" });
    requestLeaderboard.mockResolvedValue({ entries: [], total: 0, scope: "public" });
    expect(await newUiApi.getLeaderboard(query)).toMatchObject({ status: "unavailable" });
    requestLeaderboard.mockResolvedValue({
      entries: [],
      total: 0,
      scope: "private",
      system: "trueskill",
      policyVersion: "shag-trueskill-v1",
    });
    expect(await newUiApi.getLeaderboard(query)).toEqual({
      status: "ready",
      data: { entries: [], total: 0, scope: "private", system: "trueskill", policyVersion: "shag-trueskill-v1" },
    });
  });
  it("uses only the advertised lobby result and keeps offline servers unavailable", async () => {
    const page = {
      scope: "public" as const,
      system: "trueskill" as const,
      policyVersion: "shag-trueskill-v1",
      entries: [
        {
          rank: 1,
          playerId: "12",
          name: "Player",
          wins: 2,
          losses: 0,
          draws: 1,
          rating: 1200,
          conservativeScore: 5,
          ratedMatches: 3,
          provisional: true,
        },
      ],
      total: 1,
      localPlayerRank: 1,
      localPlayerEntry: {
        rank: 1,
        playerId: "12",
        name: "Player",
        wins: 2,
        losses: 0,
        draws: 1,
        rating: 1200,
        conservativeScore: 5,
        ratedMatches: 3,
        provisional: true,
      },
    };
    const requestLeaderboard = vi.fn().mockResolvedValue(page);
    const client = { connected: true, requestLeaderboard } as unknown as LobbyClient;
    const query = { gametype: "amphi", period: "month" as const, offset: 0, limit: 100 };
    bindLeaderboard(client, false);
    expect(await newUiApi.getLeaderboard(query)).toMatchObject({ status: "unavailable" });
    expect(requestLeaderboard).not.toHaveBeenCalled();
    bindLeaderboard(client, true, true);
    expect(await newUiApi.getLeaderboard(query)).toEqual({ status: "ready", data: page });
    expect(requestLeaderboard).toHaveBeenCalledWith({ ...query, system: "trueskill" });
    bindLeaderboard({ connected: false } as LobbyClient, true);
    expect(newUiApi.getFeatureStatus("leaderboard").status).toBe("unavailable");
  });
  it("requires skill capability and rejects records-only or partial skill replies", async () => {
    const requestLeaderboard = vi.fn().mockResolvedValue({ entries: [], total: 0, scope: "public" });
    const client = { connected: true, requestLeaderboard } as unknown as LobbyClient;
    const query = { gametype: "duel", period: "all" as const, offset: 0, limit: 1 };
    bindLeaderboard(client, true);
    expect(newUiApi.getFeatureStatus("leaderboard").status).toBe("unavailable");
    expect((await newUiApi.getLeaderboard(query)).status).toBe("unavailable");
    expect(requestLeaderboard).not.toHaveBeenCalled();
    bindLeaderboard(client, true, true);
    expect((await newUiApi.getLeaderboard(query)).status).toBe("unavailable");
    requestLeaderboard.mockResolvedValue({
      entries: [{ rating: 1000 }],
      total: 1,
      scope: "public",
      system: "trueskill",
      policyVersion: "shag-trueskill-v1",
    });
    expect((await newUiApi.getLeaderboard(query)).status).toBe("unavailable");
  });
});

describe("featured demo UI adapter", () => {
  it("uses only the advertised lobby result and preserves offline state", async () => {
    const entries = [{ demo: { filename: "real.shagdemo" }, rank: 1, reason: "Recent multiplayer recording" }];
    const requestFeaturedDemos = vi.fn().mockResolvedValue({ entries });
    const client = { connected: true, requestFeaturedDemos } as unknown as LobbyClient;
    const query = { gametype: "duel", limit: 5 };
    bindFeaturedDemos(client, false);
    expect(await newUiApi.getFeaturedDemos(query)).toMatchObject({ status: "unavailable" });
    expect(requestFeaturedDemos).not.toHaveBeenCalled();
    bindFeaturedDemos(client, true);
    expect(await newUiApi.getFeaturedDemos(query)).toEqual({ status: "ready", data: entries });
    expect(requestFeaturedDemos).toHaveBeenCalledWith(query);
  });
});
