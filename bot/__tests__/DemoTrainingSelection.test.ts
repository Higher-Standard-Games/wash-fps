/**
 * Training on demos is training on people. A seat with a verified account is a
 * person; a bot carries none, so taking every player in a demo would teach the
 * network the state machine it exists to grow beyond.
 *
 * TF-3 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import { describe, expect, it } from "vitest";
import { selectPlayers } from "../DemoTrainingExtractor";

const human = (id: string, accountId: number) => ({ playerId: id, name: id, accountId });
const bot = (id: string) => ({ playerId: id, name: id });

describe("selectPlayers", () => {
  it("keeps the people and drops the bots", () => {
    const { kept, dropped } = selectPlayers([human("a", 1), bot("Nova"), human("b", 2), bot("Wraith")]);
    expect(kept.map((p) => p.playerId)).toEqual(["a", "b"]);
    expect(dropped).toBe(2);
  });

  it("keeps everyone when asked, for self-play data", () => {
    const { kept, dropped } = selectPlayers([human("a", 1), bot("Nova")], { includeBots: true });
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("keeps nobody from a demo that predates accounts", () => {
    // Version-1 demos carry no account ids, so nothing in them is provably human
    const { kept, dropped } = selectPlayers([bot("old_a"), bot("old_b")]);
    expect(kept).toEqual([]);
    expect(dropped).toBe(2);
  });

  it("treats a zero or negative account as not a person", () => {
    const { kept } = selectPlayers([{ playerId: "x", name: "x", accountId: 0 }, human("ok", 5)]);
    expect(kept.map((p) => p.playerId)).toEqual(["ok"]);
  });
});
