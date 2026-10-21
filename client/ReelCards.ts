/**
 * A highlight reel's opening and closing cards: what the match was, who
 * played, and how it went. Pure data from the demo; DemoViewerHUD draws them.
 */

import type { DemoAnalysis } from "../../../shared/demo/DemoAnalyzer";
import { normalizeDemoMapName } from "../../../shared/demo/DemoMapName";
import type { DemoHeader } from "../../../shared/demo/DemoReader";
import type { CinematicReel, CinematicSegment } from "../../../shared/demo/SequenceBuilder";

const MODE_TITLES: Record<string, string> = {
  duel: "Duel",
  amphi: "Amphi",
  ffa: "Free for all",
  deathmatch: "Free for all",
  snd: "Search & destroy",
  searchanddestroy: "Search & destroy",
  tdm: "Team deathmatch",
  teamdeathmatch: "Team deathmatch",
};

/** Names shown for a free-for-all before the rest are counted. */
const FFA_NAMES_SHOWN = 8;

/** One side of the match: a team with its players, or everyone in a free-for-all. */
export interface ReelSide {
  /** The team's name; none for a duel's player or a free-for-all. */
  label?: string;
  names: string[];
}

export interface ReelTitle {
  mode: string;
  map: string;
  /** Two sides face each other ("vs" between); one side is everyone. */
  sides: ReelSide[];
  /** Players a free-for-all's list leaves out. */
  more: number;
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The opening card. Teams show as two sides with every player's name; a duel
 * as its two players; a free-for-all as everyone, up to FFA_NAMES_SHOWN.
 */
export function reelTitle(header: DemoHeader, mapTitle?: string): ReelTitle {
  const modeId = header.gametype.toLowerCase().replace(/[^a-z]/g, "");
  const mode = MODE_TITLES[modeId] ?? capitalize(header.gametype.replace(/_/g, " "));
  const map = mapTitle || normalizeDemoMapName(header.map);
  const players = header.players.filter((p) => p.name);

  const teams = new Map<string, string[]>();
  for (const player of players) {
    if (!player.team || player.team === "spectator") continue;
    const names = teams.get(player.team) ?? [];
    names.push(player.name);
    teams.set(player.team, names);
  }
  if (teams.size >= 2) {
    const sides = [...teams].map(([team, names]) => ({ label: capitalize(team), names }));
    return { mode, map, sides, more: 0 };
  }
  if (players.length === 2) {
    return { mode, map, sides: players.map((p) => ({ names: [p.name] })), more: 0 };
  }
  const names = players.map((p) => p.name);
  return {
    mode,
    map,
    sides: [{ names: names.slice(0, FFA_NAMES_SHOWN) }],
    more: Math.max(0, names.length - FFA_NAMES_SHOWN),
  };
}

export interface ReelSummary {
  topFragger?: { name: string; frags: number };
  /** The reel's best-scoring frag. */
  best?: { title: string; player: string };
  /** Frag scenes and trick-jump clips in the reel. */
  frags: number;
  tricks: number;
}

/** The closing card: the match's top fragger and the reel's best moment. */
export function reelSummary(
  reel: CinematicReel,
  analysis: Pick<DemoAnalysis, "frags" | "playerNames">,
  titleOf: (segment: CinematicSegment) => string,
): ReelSummary {
  const highlights = [...new Set(reel.segments.map((s) => s.highlight))];
  const fragScenes = highlights.filter((h) => h.type !== "movement");
  const summary: ReelSummary = {
    frags: fragScenes.length,
    tricks: highlights.length - fragScenes.length,
  };

  let top: [string, number] | undefined;
  for (const entry of analysis.frags) if (!top || entry[1] > top[1]) top = entry;
  if (top) summary.topFragger = { name: analysis.playerNames.get(top[0]) ?? top[0], frags: top[1] };

  const best = [...fragScenes].sort((a, b) => b.score - a.score)[0];
  const scene = best && reel.segments.find((s) => s.highlight === best);
  if (scene) summary.best = { title: titleOf(scene), player: best.primaryPlayerName };
  return summary;
}
