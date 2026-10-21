import { describe, expect, it } from "vitest";
import type { HighlightCandidate } from "../../../../shared/demo/DemoAnalyzer";
import type { DemoHeader } from "../../../../shared/demo/DemoReader";
import type { CinematicReel, CinematicSegment } from "../../../../shared/demo/SequenceBuilder";
import { reelSummary, reelTitle } from "../ReelCards";

const header = (gametype: string, players: Array<[string, string]>): DemoHeader => ({
  version: 1,
  map: "wdm7",
  gametype,
  tickRate: 125,
  snapshotRate: 60,
  startTime: 0,
  players: players.map(([name, team], i) => ({ playerId: String(i), name, team })),
});

describe("a reel's title card", () => {
  it("shows a team game as its two teams with every player's name", () => {
    const title = reelTitle(
      header("snd", [
        ["Ann", "udon"],
        ["Bo", "soba"],
        ["Cy", "udon"],
        ["Di", "soba"],
      ]),
      "Campgrounds",
    );
    expect(title).toEqual({
      mode: "Search & destroy",
      map: "Campgrounds",
      sides: [
        { label: "Udon", names: ["Ann", "Cy"] },
        { label: "Soba", names: ["Bo", "Di"] },
      ],
      more: 0,
    });
  });

  it("shows a duel as its two players, one against the other", () => {
    const title = reelTitle(
      header("duel", [
        ["Ann", ""],
        ["Bo", ""],
      ]),
    );
    expect(title.mode).toBe("Duel");
    expect(title.map).toBe("wdm7");
    expect(title.sides).toEqual([{ names: ["Ann"] }, { names: ["Bo"] }]);
  });

  it("lists everyone in a free-for-all, counting those past eight", () => {
    const players = Array.from({ length: 10 }, (_, i): [string, string] => [`P${i}`, ""]);
    const title = reelTitle(header("deathmatch", players));
    expect(title.mode).toBe("Free for all");
    expect(title.sides).toHaveLength(1);
    expect(title.sides[0].names).toHaveLength(8);
    expect(title.more).toBe(2);
  });
});

describe("a reel's end card", () => {
  const highlight = (type: HighlightCandidate["type"], score: number, player: string) =>
    ({ type, score, primaryPlayerName: player }) as HighlightCandidate;
  const segment = (h: HighlightCandidate) => ({ highlight: h }) as CinematicSegment;

  it("names the match's top fragger and the reel's best frag, and counts its scenes", () => {
    const frag = highlight("frag", 10, "Bo");
    const multi = highlight("multi_kill", 25, "Ann");
    const trick = highlight("movement", 40, "Cy");
    const reel = {
      segments: [segment(frag), segment(frag), segment(trick), segment(multi), segment(multi)],
      totalScenes: 3,
    } as CinematicReel;
    const summary = reelSummary(
      reel,
      {
        frags: new Map([
          ["player_1", 3],
          ["player_2", 7],
        ]),
        playerNames: new Map([["player_2", "Ann"]]),
      },
      (s) => (s.highlight === multi ? "Multi kill ×2" : "Frag"),
    );
    expect(summary).toEqual({
      topFragger: { name: "Ann", frags: 7 },
      best: { title: "Multi kill ×2", player: "Ann" },
      frags: 2,
      tricks: 1,
    });
  });
});
