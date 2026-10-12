/**
 * LobbyRooms — the decisions LobbyPanel makes about rooms and its Play keys,
 * kept free of the DOM so they can be tested on their own.
 */

import type { LiveMatchInfo } from "../../../lobby/types";

type Room = Pick<LiveMatchInfo, "state" | "playerCount" | "maxPlayers" | "serverUrl" | "map" | "mapDisplayName">;

/** A room still forming with a free seat. */
export function isJoinable(match: Pick<Room, "state" | "playerCount" | "maxPlayers">): boolean {
  return match.state === "waiting" && match.playerCount < match.maxPlayers;
}

/**
 * Rooms in list order: joinable first, fewest seats left on top; then full
 * rooms about to start; then running matches. Returns a new array.
 */
export function sortRooms<T extends Pick<Room, "state" | "playerCount" | "maxPlayers">>(matches: readonly T[]): T[] {
  const rank = (match: T) => (isJoinable(match) ? 0 : match.state === "waiting" ? 1 : 2);
  return [...matches].sort(
    (a, b) => rank(a) - rank(b) || a.maxPlayers - a.playerCount - (b.maxPlayers - b.playerCount),
  );
}

/** The rooms badge, "1 of 3 open": rooms a player can join out of all rooms; "none" without any. */
export function roomCountLabel(matches: readonly Pick<Room, "state" | "playerCount" | "maxPlayers">[]): string {
  if (matches.length === 0) return "none";
  return `${matches.filter(isJoinable).length} of ${matches.length} open`;
}

export type RoomAction = "join" | "watch" | "full";

export interface RoomRow {
  action: RoomAction;
  /** The map for a running match, otherwise "Open" or "Starting". */
  where: string;
  disabled: boolean;
}

/**
 * What a room's row offers. A match under way takes players while it has room,
 * as a Quake or Warsow server does; a full one can still be watched.
 */
export function describeRoom(match: Room): RoomRow {
  const dropIn = match.state === "playing" && !!match.serverUrl && match.playerCount < match.maxPlayers;
  const action: RoomAction =
    match.state === "playing" ? (dropIn ? "join" : "watch") : isJoinable(match) ? "join" : "full";
  const where = match.state === "playing" ? match.mapDisplayName || match.map : action === "full" ? "Starting" : "Open";
  const disabled = action === "full" || (action === "watch" && !match.serverUrl);
  return { action, where, disabled };
}

export interface PlayKeysInput {
  /** Title of the selected mode, such as "Duel". */
  modeTitle: string;
  /** The lobby server offers the selected mode. */
  available: boolean;
  connected: boolean;
  queuePending: boolean;
  privateLobbySupported: boolean;
  /** Turned away at the lobby's player cap, rather than unable to reach it. */
  lobbyFull?: boolean;
}

export interface PlayKeys {
  find: { disabled: boolean; label: string };
  private: { disabled: boolean; title: string };
}

/** State of the Find and Private keys on the Play stage. */
export function playKeys({
  modeTitle,
  available,
  connected,
  queuePending,
  privateLobbySupported,
  lobbyFull = false,
}: PlayKeysInput): PlayKeys {
  const label = queuePending
    ? "Joining…"
    : !connected
      ? lobbyFull
        ? "Servers full"
        : "Lobby offline"
      : available
        ? `Find ${modeTitle}`
        : `${modeTitle} soon`;
  return {
    find: { disabled: queuePending || !connected || !available, label },
    private: {
      disabled: queuePending || !connected || !available || !privateLobbySupported,
      title: !privateLobbySupported
        ? "This lobby server does not offer private rooms."
        : !available
          ? "This mode is not offered by the lobby server."
          : "Create an invite-only room.",
    },
  };
}
