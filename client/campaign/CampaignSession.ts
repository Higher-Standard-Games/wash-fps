/**
 * The campaign between pages: this account's last known progress in
 * localStorage, and the mission being played in sessionStorage, which carries
 * it from the lobby's connect hand-off to the game and back to the lobby after
 * the match.
 */

import type { CampaignProgress, CampaignStateMessage, LobbyCampaignInfo } from "../../../../lobby/types";

const PROGRESS_KEY = "washoi.campaign.";
const MATCH_KEY = "washoi.campaign_match";

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

/** Back in the lobby after a campaign match: which mission it was, once. */
export function takeCampaignReturn(): LobbyCampaignInfo | null {
  const info = campaignMatch();
  rememberCampaignMatch(undefined);
  return info;
}
