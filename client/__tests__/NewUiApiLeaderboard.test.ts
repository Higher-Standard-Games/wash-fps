import { afterEach, describe, expect, it, vi } from "vitest";
import type { LobbyClient } from "../../../../lobby/LobbyClient";
import { bindFeaturedDemos, bindLeaderboard, newUiApi } from "../NewUiApi";

afterEach(() => {
  bindLeaderboard({ connected: false } as LobbyClient, false);
  bindFeaturedDemos({ connected: false } as LobbyClient, false);
});

describe("leaderboard UI adapter", () => {
  it("uses only the advertised lobby result and keeps offline servers unavailable", async () => {
    const page = {
      entries: [{ rank: 1, playerId: "12", name: "Player", wins: 2, losses: 0, draws: 1 }],
      total: 1,
      localPlayerRank: 1,
      localPlayerEntry: { rank: 1, playerId: "12", name: "Player", wins: 2, losses: 0, draws: 1 },
    };
    const requestLeaderboard = vi.fn().mockResolvedValue(page);
    const client = { connected: true, requestLeaderboard } as unknown as LobbyClient;
    const query = { gametype: "amphi", period: "month" as const, offset: 0, limit: 100 };
    bindLeaderboard(client, false);
    expect(await newUiApi.getLeaderboard(query)).toMatchObject({ status: "unavailable" });
    expect(requestLeaderboard).not.toHaveBeenCalled();
    bindLeaderboard(client, true);
    expect(await newUiApi.getLeaderboard(query)).toEqual({ status: "ready", data: page });
    expect(requestLeaderboard).toHaveBeenCalledWith(query);
    bindLeaderboard({ connected: false } as LobbyClient, true);
    expect(newUiApi.getFeatureStatus("leaderboard").status).toBe("unavailable");
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
