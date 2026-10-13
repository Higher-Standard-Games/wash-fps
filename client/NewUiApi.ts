/**
 * Contracts for prototype screens that need server features before they can be live.
 * Player accounts, room chat, and private rooms are live: see AccountSession,
 * ProfileView, LobbyClient, and RoomChatView.
 * Leaderboard and featured demo reads use advertised lobby endpoints.
 * See docs/research/NEW_UI.md for the remaining work.
 */

import type { LobbyClient } from "../../../lobby/LobbyClient";
import type { HistoryPage, StatsQuery, StatsSummary } from "../../../lobby/PlayerStatsStore";
import type { FeaturedDemoInfo, GametypeInfo, LeaderboardEntry, RankingScope } from "../../../lobby/types";
import { canonicalMatchStats } from "../../../shared/ranking/MatchStats";
import { RATING_POLICY } from "../../../shared/ranking/RatingPolicy";

export type UiResult<T> = { status: "ready"; data: T } | { status: "unavailable"; reason: string };

export type PendingUiFeature = "leaderboard" | "featuredDemos" | "playerStats";

export interface LeaderboardQuery {
  gametype: string;
  period: "month" | "all";
  offset: number;
  limit: number;
  scope?: RankingScope;
}

export interface LeaderboardPage {
  scope?: RankingScope;
  entries: LeaderboardEntry[];
  system?: "trueskill";
  policyVersion?: string;
  localProcessing?: { excluded: number };
  total: number;
  localPlayerRank?: number;
  localPlayerEntry?: LeaderboardPage["entries"][number];
}

export interface FeaturedDemosQuery {
  gametype?: string;
  map?: string;
  limit: number;
}

export type FeaturedDemo = FeaturedDemoInfo;

export interface NewUiApi {
  /** Availability comes from the server's welcome.gametypes, not prototype data. */
  getMode(gametypeId: string, advertised: readonly GametypeInfo[]): UiResult<GametypeInfo>;
  getFeatureStatus(feature: PendingUiFeature): UiResult<true>;
  getLeaderboard(query: LeaderboardQuery): Promise<UiResult<LeaderboardPage>>;
  getPlayerStats(query: StatsQuery): Promise<UiResult<StatsSummary>>;
  getMatchHistory(
    query: Pick<StatsQuery, "gametype" | "scope"> & { limit?: number; beforeSequence?: number },
  ): Promise<UiResult<HistoryPage>>;
  getFeaturedDemos(query: FeaturedDemosQuery): Promise<UiResult<FeaturedDemo[]>>;
}

const UNAVAILABLE: Record<PendingUiFeature, string> = {
  playerStats: "Player stats are unavailable on this lobby server.",
  leaderboard: "Rankings are unavailable on this lobby server.",
  featuredDemos: "Featured demos are unavailable on this lobby server. The demo archive is available.",
};

const OFFLINE: Record<PendingUiFeature, string> = {
  playerStats: "The lobby server is offline. Player stats come back with it.",
  leaderboard: "The lobby server is offline. Rankings come back with it.",
  featuredDemos: "The lobby server is offline. Featured picks come back with it.",
};

/** Why a feature cannot be read: the lobby is not there, or it does not offer it. */
function unavailable<T>(feature: PendingUiFeature, client: LobbyClient | null): UiResult<T> {
  return { status: "unavailable", reason: client?.connected ? UNAVAILABLE[feature] : OFFLINE[feature] };
}

let leaderboardClient: LobbyClient | null = null;
let leaderboardSupported = false;
let featuredClient: LobbyClient | null = null;
let featuredSupported = false;
let statsClient: LobbyClient | null = null;
let statsSupported = false;
export function bindPlayerStats(client: LobbyClient, supported: boolean): void {
  statsClient = client;
  statsSupported = supported;
}

/** The panel binds the authenticated connection and advertised server capability. */
export function bindLeaderboard(client: LobbyClient, supported: boolean, skillRatings = false): void {
  leaderboardClient = client;
  leaderboardSupported = supported && skillRatings;
}

export function bindFeaturedDemos(client: LobbyClient, supported: boolean): void {
  featuredClient = client;
  featuredSupported = supported;
}

/** Keep unavailable states honest; never return fabricated data. */
export const newUiApi: NewUiApi = {
  getMode(gametypeId, advertised) {
    const mode = advertised.find((item) => item.id === gametypeId);
    return mode
      ? { status: "ready", data: mode }
      : { status: "unavailable", reason: `${gametypeId.toUpperCase()} is not offered by this lobby server yet.` };
  },
  getFeatureStatus(feature) {
    if (feature === "playerStats")
      return statsSupported && statsClient?.connected
        ? { status: "ready", data: true }
        : unavailable(feature, statsClient);
    if (feature === "leaderboard" && leaderboardSupported && leaderboardClient?.connected) {
      return { status: "ready", data: true };
    }
    if (feature === "featuredDemos" && featuredSupported && featuredClient?.connected) {
      return { status: "ready", data: true };
    }
    return unavailable(feature, feature === "leaderboard" ? leaderboardClient : featuredClient);
  },
  async getPlayerStats(query) {
    if (!statsSupported || !statsClient?.connected) return unavailable("playerStats", statsClient);
    try {
      const data = await statsClient.requestPlayerStats(query);
      if (
        data.scope !== query.scope ||
        data.gametype !== query.gametype ||
        data.period !== query.period ||
        [data.matches, data.wins, data.losses, data.draws, data.statsMatches, data.excluded].some(
          (n) => !Number.isSafeInteger(n) || n < 0,
        ) ||
        data.matches !== data.wins + data.losses + data.draws ||
        data.statsMatches > data.matches ||
        (data.statsMatches === 0) !== (data.totals === null)
      )
        throw new Error("Invalid player stats");
      if (data.totals) canonicalMatchStats({ version: 1, ...data.totals });
      if (
        data.rating !== null &&
        (!Number.isSafeInteger(data.rating.value) ||
          !Number.isSafeInteger(data.rating.rank) ||
          data.rating.rank < 1 ||
          !Number.isSafeInteger(data.rating.ratedMatches) ||
          data.rating.ratedMatches < 1 ||
          typeof data.rating.provisional !== "boolean")
      )
        throw new Error("Invalid rating summary");
      return { status: "ready", data };
    } catch {
      return { status: "unavailable", reason: "Could not read your player stats." };
    }
  },
  async getMatchHistory(query) {
    if (!statsSupported || !statsClient?.connected) return unavailable("playerStats", statsClient);
    try {
      const data = await statsClient.requestMatchHistory(query);
      if (
        data.scope !== query.scope ||
        data.gametype !== query.gametype ||
        !Array.isArray(data.entries) ||
        data.entries.length > (query.limit ?? 20) ||
        (data.nextBeforeSequence !== null &&
          (!Number.isSafeInteger(data.nextBeforeSequence) || data.nextBeforeSequence < 1))
      )
        throw new Error("Invalid history");
      let prior = query.beforeSequence ?? Number.MAX_SAFE_INTEGER;
      for (const entry of data.entries) {
        if (
          entry.scope !== query.scope ||
          entry.gametype !== query.gametype ||
          !Number.isSafeInteger(entry.sequence) ||
          entry.sequence < 1 ||
          entry.sequence >= prior ||
          typeof entry.matchId !== "string" ||
          typeof entry.map !== "string" ||
          !Number.isSafeInteger(entry.score) ||
          !Number.isSafeInteger(entry.startedAt) ||
          !Number.isSafeInteger(entry.endedAt) ||
          entry.endedAt < entry.startedAt ||
          !["normal", "forfeit", "aborted"].includes(entry.completion) ||
          !["win", "loss", "draw", null].includes(entry.outcome) ||
          !["recorded", "excluded"].includes(entry.recordStatus) ||
          !["excluded", "applied"].includes(entry.ratingStatus) ||
          typeof entry.ratingReason !== "string"
        )
          throw new Error("Invalid match history row");
        prior = entry.sequence;
        if (entry.stats !== null) canonicalMatchStats(entry.stats);
        if (
          entry.ratingChange !== null &&
          (entry.ratingStatus !== "applied" ||
            ![entry.ratingChange.before, entry.ratingChange.after, entry.ratingChange.delta].every(
              Number.isSafeInteger,
            ) ||
            entry.ratingChange.delta !== entry.ratingChange.after - entry.ratingChange.before)
        )
          throw new Error("Invalid rating change");
      }
      if (data.nextBeforeSequence !== null && (!data.entries.length || data.nextBeforeSequence !== prior))
        throw new Error("Invalid history cursor");
      return { status: "ready", data };
    } catch {
      return { status: "unavailable", reason: "Could not read your match history." };
    }
  },
  async getLeaderboard(query) {
    if (!leaderboardSupported || !leaderboardClient?.connected) return unavailable("leaderboard", leaderboardClient);
    try {
      const { entries, total, localPlayerRank, localPlayerEntry, scope, system, policyVersion, localProcessing } =
        await leaderboardClient.requestLeaderboard({ ...query, system: "trueskill" });
      const valid = (row: LeaderboardEntry) =>
        Number.isSafeInteger(row.rating) &&
        Number.isFinite(row.conservativeScore) &&
        typeof row.provisional === "boolean" &&
        Number.isSafeInteger(row.ratedMatches) &&
        row.ratedMatches! > 0;
      if (
        scope !== (query.scope ?? "public") ||
        system !== "trueskill" ||
        policyVersion !== RATING_POLICY.version ||
        !entries.every(valid) ||
        (localPlayerEntry && !valid(localPlayerEntry))
      ) {
        return { status: "unavailable", reason: "This lobby server did not return the requested ranking." };
      }
      return {
        status: "ready",
        data: {
          entries,
          total,
          localPlayerRank,
          localPlayerEntry,
          scope,
          system,
          policyVersion,
          localProcessing,
        },
      };
    } catch (error) {
      return { status: "unavailable", reason: (error as Error).message };
    }
  },
  async getFeaturedDemos(query) {
    if (!featuredSupported || !featuredClient?.connected) return unavailable("featuredDemos", featuredClient);
    try {
      const { entries } = await featuredClient.requestFeaturedDemos(query);
      return { status: "ready", data: entries };
    } catch (error) {
      return { status: "unavailable", reason: (error as Error).message };
    }
  },
};
