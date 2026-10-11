/**
 * Contracts for prototype screens that need server features before they can be live.
 * Player accounts, room chat, and private rooms are live: see AccountSession,
 * ProfileView, LobbyClient, and RoomChatView.
 * Leaderboard and featured demo reads use advertised lobby endpoints.
 * See docs/research/NEW_UI.md for the remaining work.
 */

import type { LobbyClient } from "../../../lobby/LobbyClient";
import type { FeaturedDemoInfo, GametypeInfo, LeaderboardEntry, RankingScope } from "../../../lobby/types";
import { RATING_POLICY } from "../../../shared/ranking/RatingPolicy";

export type UiResult<T> = { status: "ready"; data: T } | { status: "unavailable"; reason: string };

export type PendingUiFeature = "leaderboard" | "featuredDemos";

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
  localProcessing?: { pending: number; excluded: number };
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
  getFeaturedDemos(query: FeaturedDemosQuery): Promise<UiResult<FeaturedDemo[]>>;
}

const UNAVAILABLE: Record<PendingUiFeature, string> = {
  leaderboard: "Rankings are unavailable on this lobby server.",
  featuredDemos: "Featured demos are unavailable on this lobby server. The demo archive is available.",
};

const OFFLINE: Record<PendingUiFeature, string> = {
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
    if (feature === "leaderboard" && leaderboardSupported && leaderboardClient?.connected) {
      return { status: "ready", data: true };
    }
    if (feature === "featuredDemos" && featuredSupported && featuredClient?.connected) {
      return { status: "ready", data: true };
    }
    return unavailable(feature, feature === "leaderboard" ? leaderboardClient : featuredClient);
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
