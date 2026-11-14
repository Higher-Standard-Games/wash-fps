import { describe, expect, it } from "vitest";
import type { HighlightCandidate } from "../../../../shared/demo/DemoAnalyzer";
import type { DemoHeader } from "../../../../shared/demo/DemoReader";
import type { CinematicReel, CinematicSegment } from "../../../../shared/demo/SequenceBuilder";
import { demoEndCard, reelEndCard, reelSummary, reelTitle } from "../ReelCards";

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

  it("draws a reel's summary as its end card", () => {
    expect(reelEndCard({ topFragger: { name: "Ann", frags: 7 }, frags: 2, tricks: 1 })).toEqual({
      chips: [{ label: "Top fragger", value: "Ann · 7 frags" }],
      counts: "2 highlights · 1 trick jump",
    });
  });

  it("closes a whole demo on its winner from the final scores, and its frags in its length", () => {
    const players = [
      { name: "Ann", score: 9 },
      { name: "Bo", score: 14 },
    ];
    expect(demoEndCard({ players, frags: 25, durationMs: 125_400 })).toEqual({
      chips: [{ label: "Winner", value: "Bo · 14 frags" }],
      counts: "25 frags · 2:05",
    });
    const level = [
      { name: "Ann", score: 3 },
      { name: "Bo", score: 3 },
    ];
    expect(demoEndCard({ players: level, frags: 6, durationMs: 59_000 }).chips).toEqual([
      { label: "Winner", value: "Draw" },
    ]);
    const teams = [
      { name: "Udon", score: 7 },
      { name: "Soba", score: 5 },
    ];
    const four = [...players, { name: "Cy", score: 2 }, { name: "Di", score: 1 }];
    expect(demoEndCard({ players: four, sides: teams, frags: 1, durationMs: 60_000 })).toEqual({
      chips: [
        { label: "Winner", value: "Udon" },
        { label: "Top fragger", value: "Bo · 14 frags" },
      ],
      counts: "1 frag · 1:00",
    });
    // One player a side, as in Amphi: its round wins decide, not the last round's frags
    const rounds = [
      { name: "Ann", score: 3 },
      { name: "Bo", score: 1 },
    ];
    expect(demoEndCard({ players, sides: rounds, frags: 30, durationMs: 60_000 }).chips).toEqual([
      { label: "Winner", value: "Ann" },
    ]);
    // Level on rounds: the last round, still on the frag counts, decided it
    const level2 = [
      { name: "Ann", score: 2 },
      { name: "Bo", score: 2 },
    ];
    expect(demoEndCard({ players, sides: level2, frags: 30, durationMs: 60_000 }).chips).toEqual([
      { label: "Winner", value: "Bo" },
    ]);
    // Teams level: no winner the recording can show
    expect(demoEndCard({ players: four, sides: level2, frags: 30, durationMs: 60_000 }).chips).toEqual([
      { label: "Top fragger", value: "Bo · 14 frags" },
    ]);
    expect(demoEndCard({ players: [], frags: 0, durationMs: 59_000 })).toEqual({ chips: [], counts: "0 frags · 0:59" });
  });
});
