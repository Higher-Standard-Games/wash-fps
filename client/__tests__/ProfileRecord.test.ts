// @vitest-environment jsdom

/**
 * The record card on the Profile page. Every number on it comes from the
 * lobby's leaderboard, so the card has to be honest about a lobby that is
 * offline, one that does not rank at all, and an account that has not finished
 * a ranked match yet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GametypeInfo } from "../../../../lobby/types";
import { bindLeaderboard } from "../NewUiApi";
import { ProfileView } from "../ProfileView";

const MODES = [
  { id: "duel", name: "DUEL", description: "", maxPlayers: 2, hasTeams: false, mapPool: [] },
  { id: "amphi", name: "AMPHITHEATRE", description: "", maxPlayers: 2, hasTeams: false, mapPool: [] },
] as unknown as GametypeInfo[];

type Row = { rank: number; playerId: string; name: string; wins: number; losses: number; draws: number };

function fakeClient(
  answer: (gametype: string) => { total: number; localPlayerEntry?: Row } | Promise<never>,
  connected = true,
): { connected: boolean; on: () => () => void; requestLeaderboard: ReturnType<typeof vi.fn> } {
  return {
    connected,
    on: () => () => {},
    requestLeaderboard: vi.fn(async (query: { gametype: string }) => ({
      entries: [],
      ...(await answer(query.gametype)),
    })),
  };
}

function mount(client: unknown, supported = true): ProfileView {
  bindLeaderboard(client as never, supported);
  return new ProfileView({
    client: client as never,
    isInRoom: () => false,
    modes: () => MODES,
  });
}

const status = (view: ProfileView): string =>
  view.root.querySelector(".lobby-card--record .lobby-card__note")?.textContent ?? "";
const rows = (view: ProfileView): string[][] =>
  [...view.root.querySelectorAll(".profile-record__row")].map((row) =>
    [...row.children].map((cell) => cell.textContent ?? ""),
  );

const row = (over: Partial<Row> = {}): Row => ({
  rank: 3,
  playerId: "7",
  name: "Tester",
  wins: 4,
  losses: 1,
  draws: 0,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});

describe("the record card", () => {
  it("says so when the lobby is not there to ask", async () => {
    const view = mount(fakeClient(() => ({ total: 0 }), false));
    await view.refreshRecord();
    expect(status(view)).toBe("Connect to the lobby to see your record.");
    expect(rows(view)).toEqual([]);
  });

  it("passes on a lobby that does not rank at all", async () => {
    const client = fakeClient(() => ({ total: 0 }));
    const view = mount(client, false);
    await view.refreshRecord();
    expect(status(view)).toMatch(/unavailable on this lobby server/);
    expect(client.requestLeaderboard).not.toHaveBeenCalled();
  });

  it("explains an empty record instead of showing zeroes", async () => {
    const view = mount(fakeClient(() => ({ total: 12 })));
    await view.refreshRecord();
    expect(status(view)).toMatch(/No ranked match yet/);
    expect(rows(view)).toEqual([]);
  });

  it("lists a line per mode, best rank first", async () => {
    const view = mount(
      fakeClient((gametype) => ({
        total: 40,
        localPlayerEntry:
          gametype === "duel" ? row({ rank: 9, wins: 2, losses: 7 }) : row({ rank: 2, wins: 5, draws: 1 }),
      })),
    );
    await view.refreshRecord();
    expect(rows(view)).toEqual([
      ["AMPHITHEATRE", "#2", "5 W", "1 L", "1 D"],
      ["DUEL", "#9", "2 W", "7 L", "0 D"],
    ]);
    expect(status(view)).toBe("16 ranked matches · best #2 in AMPHITHEATRE");
  });

  it("counts one match as a match", async () => {
    const view = mount(
      fakeClient((gametype) =>
        gametype === "duel" ? { total: 1, localPlayerEntry: row({ rank: 1, wins: 1, losses: 0 }) } : { total: 0 },
      ),
    );
    await view.refreshRecord();
    expect(status(view)).toBe("1 ranked match · best #1 in DUEL");
  });

  it("still shows the modes that answered when one does not", async () => {
    const view = mount(
      fakeClient((gametype) => {
        if (gametype === "duel") return Promise.reject(new Error("Rankings timed out."));
        return { total: 4, localPlayerEntry: row({ rank: 1, wins: 3, losses: 0 }) };
      }),
    );
    await view.refreshRecord();
    expect(rows(view)).toEqual([["AMPHITHEATRE", "#1", "3 W", "0 L", "0 D"]]);
    expect(status(view)).toBe("3 ranked matches · best #1 in AMPHITHEATRE");
  });

  it("reports the refusal when nothing could be read", async () => {
    const view = mount(fakeClient(() => Promise.reject(new Error("Rankings timed out."))));
    await view.refreshRecord();
    expect(status(view)).toBe("Rankings timed out.");
    expect(rows(view)).toEqual([]);
  });
});
