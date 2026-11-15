/**
 * The campaign's own music: the campaign page plays its opener over the
 * menus' playlist, and some missions play a song of their own in place of the
 * game playlist. None of it plays anywhere else.
 */

/** The campaign page's playlist: the opener, looping. */
export const CAMPAIGN_MENU_PLAYLIST = "data/campaign.playlist.json";

/** Missions that play a song of their own, by mission id; the rest play the game playlist. */
const MISSION_PLAYLISTS: Readonly<Record<string, string>> = {
  "cartel-contract": "data/campaign_cartel.playlist.json",
  "siege-breaker": "data/campaign_boss.playlist.json",
  "road-ends": "data/campaign_boss.playlist.json",
};

/** The playlist a campaign mission's match plays, or null for the game playlist. */
export function missionPlaylist(missionId: string): string | null {
  return MISSION_PLAYLISTS[missionId] ?? null;
}
