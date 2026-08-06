import type { PlayerId } from "@engine/server/ecs/types";
import { MatchPhase } from "@shared/server/gametype";
import { describe, expect, it } from "vitest";
import { MatchState } from "../MatchState";

/**
 * Bots must not start the match before the humans it was spawned for arrive.
 *
 * Bots ready the instant they join and a bot process connects in milliseconds,
 * while a human's browser has a BSP to download and build. "No humans are
 * connected" is therefore true for the first seconds of every lobby-spawned
 * match, and acting on it started the round without its players — who then
 * joined mid-round and, correctly for a round mode, spawned dead. You loaded in
 * already fragged, having never seen a warmup.
 */
function warmupWithBots(): MatchState {
  const state = new MatchState("Search & Destroy", {}, true);
  const bots = new Set<PlayerId>([1 as PlayerId, 2 as PlayerId]);
  for (const id of bots) {
    state.addPlayer(id);
    state.setPlayerTeam(id, id === (1 as PlayerId) ? "udon" : "soba");
  }
  state.setBotPlayers(bots);
  state.setHumanClients(0);
  // Lobby-spawned: humans are queued for this match, just not connected yet.
  state.setExpectsHumans(true);
  for (const id of bots) state.playerReady(id);
  return state;
}

/** Advance warmup by `seconds`, in the 1s steps the server ticks it in. */
function advance(state: MatchState, seconds: number): void {
  for (let i = 0; i < seconds; i++) state.update(1);
}

describe("warmup with a bots-only roster", () => {
  it("does not start immediately, leaving room for a human still loading", () => {
    const state = warmupWithBots();

    advance(state, 5);

    expect(state.phase).toBe(MatchPhase.Warmup);
  });

  it("eventually starts on its own, so a headless bot server is not stuck", () => {
    const state = warmupWithBots();

    advance(state, 31);

    expect(state.phase).not.toBe(MatchPhase.Warmup);
  });

  it("starts as soon as a human readies, without waiting out the grace", () => {
    const state = warmupWithBots();
    state.setHumanClients(1);
    state.addPlayer(3 as PlayerId);
    state.setPlayerTeam(3 as PlayerId, "soba");
    state.playerReady(3 as PlayerId);

    advance(state, 1);

    expect(state.phase).not.toBe(MatchPhase.Warmup);
  });

  it("keeps waiting while a human is connected but not yet ready", () => {
    const state = warmupWithBots();
    // Connected and loading, or stood in the loadout picker — not ready.
    state.setHumanClients(1);

    advance(state, 40);

    expect(state.phase).toBe(MatchPhase.Warmup);
  });

  it("starts a standing bot server immediately — nobody is coming to that one", () => {
    // No `--single-match`, so this is a dev or training server rather than a
    // match spawned for a queued group. Headless runs depend on not waiting.
    const state = warmupWithBots();
    state.setExpectsHumans(false);

    advance(state, 1);

    expect(state.phase).not.toBe(MatchPhase.Warmup);
  });
});
