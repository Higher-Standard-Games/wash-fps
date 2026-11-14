/**
 * The opening and closing cards of a highlight reel or a whole demo: who played, and how it went. Pure data from the demo; DemoViewerHUD draws them.
 */

import type { DemoAnalysis } from "../../../shared/demo/DemoAnalyzer";
import type { DemoHeader } from "../../../shared/demo/DemoReader";
import type { CinematicReel, CinematicSegment } from "../../../shared/demo/SequenceBuilder";

/** Names shown for a free-for-all before the rest are counted. */
const FFA_NAMES_SHOWN = 8;

/** One side of the match: a team with its players, or everyone in a free-for-all. */
export interface ReelSide {
  /** The team's id ("udon", "soba"); none for a duel's player or a free-for-all. */
  team?: string;
  /** The team's name; none for a duel's player or a free-for-all. */
  label?: string;
  names: string[];
}

export interface ReelTitle {
  /** Two sides face each other ("vs" between); one side is everyone. */
  sides: ReelSide[];
  /** Players a free-for-all's list leaves out. */
  more: number;
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The opening card: who against whom. Teams show as two sides with every
 * player's name, Udon first; a duel as its two players; a free-for-all as
 * everyone, up to FFA_NAMES_SHOWN.
 */
export function reelTitle(header: Pick<DemoHeader, "players">): ReelTitle {
  const players = header.players.filter((p) => p.name);

  const teams = new Map<string, string[]>();
  for (const player of players) {
    if (!player.team || player.team === "spectator") continue;
    const names = teams.get(player.team) ?? [];
    names.push(player.name);
    teams.set(player.team, names);
  }
  if (teams.size >= 2) {
    const sides = [...teams]
      .sort(([a], [b]) => Number(b === "udon") - Number(a === "udon"))
      .map(([team, names]) => ({ team, label: capitalize(team), names }));
    return { sides, more: 0 };
  }
  if (players.length === 2) {
    return { sides: players.map((p) => ({ names: [p.name] })), more: 0 };
  }
  const names = players.map((p) => p.name);
  return { sides: [{ names: names.slice(0, FFA_NAMES_SHOWN) }], more: Math.max(0, names.length - FFA_NAMES_SHOWN) };
}

export interface ReelSummary {
  topFragger?: { name: string; frags: number };
  /** The reel's best-scoring frag. */
  best?: { title: string; player: string };
  /** Frag scenes and trick-jump clips in the reel. */
  frags: number;
  tricks: number;
}

/** A closing card as drawn: labelled chips over a line of counts. */
export interface EndCard {
  chips: Array<{ label: string; value: string }>;
  counts: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** A reel's closing card: its top fragger, best moment, and scenes. */
export function reelEndCard(summary: ReelSummary): EndCard {
  const chips: EndCard["chips"] = [];
  if (summary.topFragger) {
    const { name, frags } = summary.topFragger;
    chips.push({ label: "Top fragger", value: `${name} · ${plural(frags, "frag", "frags")}` });
  }
  if (summary.best) chips.push({ label: "Best moment", value: `${summary.best.title} · ${summary.best.player}` });
  const counts = [plural(summary.frags, "highlight", "highlights")];
  if (summary.tricks > 0) counts.push(plural(summary.tricks, "trick jump", "trick jumps"));
  return { chips, counts: counts.join(" · ") };
}

/** How a whole demo ended: the scores on its last frame. */
export interface DemoFinal {
  /** Every player's score, the HUD's frag count. */
  players: ReadonlyArray<{ name: string; score: number }>;
  /**
   * Each side's match score where the mode has sides: teams, or a duel's or
   * Amphi's two players, whose round wins decide it. None in a free-for-all.
   */
  sides?: ReadonlyArray<{ name: string; score: number }>;
  /** Frags by a player over the whole demo, suicides and falls left out. */
  frags: number;
  durationMs: number;
}

/** Whoever is alone on the top score, or null on a tie. */
function leader<T extends { score: number }>(entries: ReadonlyArray<T>): T | null {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  return sorted.length > 0 && (sorted.length === 1 || sorted[0].score > sorted[1].score) ? sorted[0] : null;
}

/**
 * A whole demo's closing card. A recording stops as the post-game begins,
 * before the last round reaches the match score, so the winner is read from
 * the final scores: the leading side where the mode has sides, or else the
 * player with most frags. Sides of one player that stand level go to the
 * frags of the round that ended it; teams that stand level get no winner, as
 * the recording cannot tell. Teams of several players get their top fragger.
 */
export function demoEndCard(final: DemoFinal): EndCard {
  const chips: EndCard["chips"] = [];
  const frags = (entry: { name: string; score: number }) => `${entry.name} · ${plural(entry.score, "frag", "frags")}`;
  if (final.sides && final.sides.length > 0) {
    const teams = final.players.length > final.sides.length;
    const winner = leader(final.sides)?.name ?? (teams ? null : (leader(final.players)?.name ?? "Draw"));
    if (winner) chips.push({ label: "Winner", value: winner });
    const top = teams ? leader(final.players) : null;
    if (top) chips.push({ label: "Top fragger", value: frags(top) });
  } else if (final.players.length > 0) {
    const top = leader(final.players);
    chips.push({ label: "Winner", value: top ? frags(top) : "Draw" });
  }
  const seconds = Math.round(final.durationMs / 1000);
  const length = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return { chips, counts: `${plural(final.frags, "frag", "frags")} · ${length}` };
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
