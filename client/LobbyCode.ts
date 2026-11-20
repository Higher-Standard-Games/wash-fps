/**
 * Room codes: a room named without a URL, for clients whose address is not
 * a link anyone could follow (a hosted build, the native client).
 *
 * - `eu:3fa9c2d1` — a public room in a region.
 * - `eu:3fa9c2d1:<invite>` — a private room, which also needs its invite.
 * - `3fa9c2d1` (or `3fa9c2d1:<invite>`) — a room in this client's region.
 *
 * A room exists only on its region's lobby, so a code carries the region.
 * The parser also takes a room link from any region's site.
 */

import { activeRegion, knownRegions, type Region } from "./hosted/Regions";

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const INVITE = /^[A-Za-z0-9_-]{1,128}$/;

export interface RoomRef {
  /** The region the room is in; null means this client's own. */
  region: Region | null;
  lobbyId: string;
  inviteToken?: string;
}

export type CodeTarget = { kind: "room"; room: RoomRef } | { kind: "elsewhere"; host: string };

/** The code for a room in `region` (this client's, by default). */
export function roomCode(lobbyId: string, inviteToken?: string | null, region = activeRegion()): string {
  return [region?.id, lobbyId, inviteToken].filter(Boolean).join(":");
}

function hostOf(region: Region): string {
  try {
    return new URL(region.dataUrl).hostname;
  } catch {
    return region.host;
  }
}

function fromLink(url: URL, regions: readonly Region[], pageHost: string | null): CodeTarget | null {
  const lobbyId = url.searchParams.get("lobby") ?? url.pathname.match(/^\/lobby\/([A-Za-z0-9_-]+)\/?$/)?.[1] ?? null;
  if (!lobbyId || !ROOM_ID.test(lobbyId)) return null;
  const invite = url.searchParams.get("invite");
  const inviteToken = invite && INVITE.test(invite) ? invite : undefined;
  const region = regions.find((candidate) => candidate.host === url.hostname || hostOf(candidate) === url.hostname);
  if (region) return { kind: "room", room: { region, lobbyId, inviteToken } };
  // A link to the site this page is on is this client's region
  if (pageHost && url.host === pageHost) return { kind: "room", room: { region: null, lobbyId, inviteToken } };
  return { kind: "elsewhere", host: url.host };
}

/**
 * The room a pasted text names, or that it is a link to another site, or null.
 * `pageHost` is this page's own host, whose room links are this region's.
 */
export function parseRoomCode(
  input: string,
  regions: readonly Region[] = knownRegions(),
  pageHost: string | null = typeof location === "undefined" ? null : location.host,
): CodeTarget | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      return fromLink(new URL(text), regions, pageHost);
    } catch {
      return null;
    }
  }
  const parts = text.split(":");
  const region = regions.find((candidate) => candidate.id === parts[0].toLowerCase()) ?? null;
  const [lobbyId, inviteToken, extra] = region ? parts.slice(1) : parts;
  if (extra !== undefined || !lobbyId || !ROOM_ID.test(lobbyId)) return null;
  if (inviteToken !== undefined && !INVITE.test(inviteToken)) return null;
  return { kind: "room", room: { region, lobbyId, ...(inviteToken ? { inviteToken } : {}) } };
}

/**
 * The first room a chat message names: a room link, or a code with its region
 * (`eu:3fa9c2d1`). A bare id is too much like an ordinary word to count.
 */
export function roomInText(text: string, regions: readonly Region[] = knownRegions()): RoomRef | null {
  for (const word of text.split(/\s+/)) {
    const candidate = word.replace(/[),.!?]+$/, "");
    const isLink = /^https?:\/\//i.test(candidate);
    const regionCode = regions.some((region) => candidate.toLowerCase().startsWith(`${region.id}:`));
    if (!isLink && !regionCode) continue;
    const target = parseRoomCode(candidate, regions);
    if (target?.kind === "room") return target.room;
  }
  return null;
}

/** Whether `room` is in this client's region. */
export function inThisRegion(room: RoomRef, here: Region | null = activeRegion()): boolean {
  return room.region === null || room.region.id === here?.id;
}
