import { describe, expect, it } from "vitest";
import type { HighlightCandidate } from "../../../../shared/demo/DemoAnalyzer";
import type { DemoHeader } from "../../../../shared/demo/DemoReader";
import type { CinematicReel, CinematicSegment } from "../../../../shared/demo/SequenceBuilder";
import { reelSummary, reelTitle } from "../ReelCards";

const header = (players: Array<[string, string]>): Pick<DemoHeader, "players"> => ({
  players: players.map(([name, team], i) => ({ playerId: String(i), name, team })),
});

describe("a reel's title card", () => {
  it("shows a team game as its two teams with every player's name, Udon first", () => {
    const title = reelTitle(
      header([
        ["Bo", "soba"],
        ["Ann", "udon"],
        ["Cy", "udon"],
        ["Di", "soba"],
      ]),
    );
    expect(title).toEqual({
      sides: [
        { team: "udon", label: "Udon", names: ["Ann", "Cy"] },
        { team: "soba", label: "Soba", names: ["Bo", "Di"] },
      ],
      more: 0,
    });
  });

  it("shows a duel as its two players, one against the other", () => {
    const title = reelTitle(
      header([
        ["Ann", ""],
        ["Bo", ""],
      ]),
    );
    expect(title.sides).toEqual([{ names: ["Ann"] }, { names: ["Bo"] }]);
  });

  it("lists everyone in a free-for-all, counting those past eight", () => {
    const players = Array.from({ length: 10 }, (_, i): [string, string] => [`P${i}`, ""]);
    const title = reelTitle(header(players));
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
