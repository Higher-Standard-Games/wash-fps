/**
 * The campaign between pages: this account's last known progress in
 * localStorage, and the mission being played in sessionStorage, which carries
 * it from the lobby's connect hand-off to the game and back to the lobby after
 * the match, with a mission to play again at once when the player asked to
 * retry it.
 */

import { lobbyCampaignInfo } from "../../../../lobby/Campaign";
import type {
  CampaignMissionInfo,
  CampaignProgress,
  CampaignStateMessage,
  LobbyCampaignInfo,
} from "../../../../lobby/types";

const PROGRESS_KEY = "washoi.campaign.";
const MATCH_KEY = "washoi.campaign_match";
const LOOKS_KEY = "washoi.campaign_looks";
const RETRY_KEY = "washoi.campaign_retry";

export type CampaignState = CampaignProgress;

function readJson<T>(storage: () => Storage, key: string): T | null {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: () => Storage, key: string, value: unknown): void {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    // Storage is a convenience here; the lobby has the record.
  }
}

/** The account's progress as this browser last heard it, to draw before the lobby answers. */
export function cachedCampaign(accountId: string): CampaignState | null {
  const state = readJson<CampaignState>(() => localStorage, PROGRESS_KEY + accountId);
  return state && Array.isArray(state.missions) && Array.isArray(state.clears) ? state : null;
}

export function cacheCampaign(accountId: string, state: CampaignStateMessage): void {
  const kept: CampaignState = {
    length: state.length,
    missions: state.missions,
    clears: state.clears,
    unlockedThrough: state.unlockedThrough,
    ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt }),
  };
  writeJson(() => localStorage, PROGRESS_KEY + accountId, kept);
}

/**
 * Keep how each mission's match is drawn (its models, its bots' own models and
 * sizes), by mission id, for its demos: a recording names only its mission.
 */
export function cacheMissionLooks(missions: readonly CampaignMissionInfo[]): void {
  writeJson(() => localStorage, LOOKS_KEY, Object.fromEntries(missions.map((m) => [m.id, lobbyCampaignInfo(m)])));
}

/** How a mission's match is drawn, as this browser last heard from the lobby; null if never. */
export function missionLook(missionId: string): LobbyCampaignInfo | null {
  const looks = readJson<Record<string, LobbyCampaignInfo>>(() => localStorage, LOOKS_KEY);
  const look = looks?.[missionId];
  return look && typeof look.missionId === "string" && look.models ? look : null;
}

/** A campaign match is starting: keep its mission and models for the game. */
export function rememberCampaignMatch(info: LobbyCampaignInfo | undefined): void {
  try {
    if (info) sessionStorage.setItem(MATCH_KEY, JSON.stringify(info));
    else sessionStorage.removeItem(MATCH_KEY);
  } catch {
    // Without storage the match plays with the player's own model settings.
  }
}

/** The campaign match this tab is connecting to, if it is one. */
export function campaignMatch(): LobbyCampaignInfo | null {
  const info = readJson<LobbyCampaignInfo>(() => sessionStorage, MATCH_KEY);
  return info && typeof info.missionId === "string" && info.models ? info : null;
}

/** The player lost a mission and asked to play it again: the lobby starts it on return. */
export function requestCampaignRetry(missionId: string): void {
  try {
    sessionStorage.setItem(RETRY_KEY, missionId);
  } catch {
    // Without storage the player starts it again from the campaign page.
  }
}

/** The mission to play again at once, if the player asked to; once. */
export function takeCampaignRetry(): string | null {
  try {
    const missionId = sessionStorage.getItem(RETRY_KEY);
    sessionStorage.removeItem(RETRY_KEY);
    return missionId;
  } catch {
    return null;
  }
}

/** Back in the lobby after a campaign match: which mission it was, once. */
export function takeCampaignReturn(): LobbyCampaignInfo | null {
  const info = campaignMatch();
  rememberCampaignMatch(undefined);
  return info;
}
