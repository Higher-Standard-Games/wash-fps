import { describe, expect, it } from "vitest";
import { describeRoom, isJoinable, playKeys, roomCountLabel, sortRooms } from "../LobbyRooms";

type State = "waiting" | "playing";

const room = (id: string, state: State, playerCount: number, maxPlayers: number, over: object = {}) => ({
  id,
  state,
  playerCount,
  maxPlayers,
  map: "wdm7",
  mapDisplayName: "Seven",
  serverUrl: undefined as string | undefined,
  ...over,
});

describe("isJoinable", () => {
  it("is a waiting room with a free seat", () => {
    expect(isJoinable(room("a", "waiting", 1, 2))).toBe(true);
    expect(isJoinable(room("a", "waiting", 2, 2))).toBe(false);
    expect(isJoinable(room("a", "playing", 1, 2))).toBe(false);
  });
});

describe("sortRooms", () => {
  it("lists joinable rooms first, then full waiting rooms, then running matches", () => {
    const sorted = sortRooms([
      room("running", "playing", 1, 8),
      room("full", "waiting", 2, 2),
      room("open", "waiting", 1, 2),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["open", "full", "running"]);
  });

  it("puts the room with the fewest seats left first within a group", () => {
    const sorted = sortRooms([
      room("roomy", "waiting", 1, 8),
      room("nearly", "waiting", 7, 8),
      room("mid", "waiting", 4, 8),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["nearly", "mid", "roomy"]);
  });

  it("does not change the list it was given", () => {
    const rooms = [room("b", "playing", 1, 2), room("a", "waiting", 1, 2)];
    sortRooms(rooms);
    expect(rooms.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("roomCountLabel", () => {
  it("counts the open rooms and all rooms", () => {
    expect(roomCountLabel([room("a", "waiting", 1, 2), room("b", "waiting", 2, 2), room("c", "playing", 1, 2)])).toBe(
      "1 of 3 open",
    );
    expect(roomCountLabel([])).toBe("none");
  });
});

describe("describeRoom", () => {
  it("offers join for a waiting room with a seat", () => {
    expect(describeRoom(room("a", "waiting", 1, 2))).toEqual({ action: "join", where: "Open", disabled: false });
  });

  it("marks a full waiting room as starting and disables it", () => {
    expect(describeRoom(room("a", "waiting", 2, 2))).toEqual({ action: "full", where: "Starting", disabled: true });
  });

  it("lets players drop into a running match with a seat and a server", () => {
    expect(describeRoom(room("a", "playing", 3, 4, { serverUrl: "wss://x" }))).toEqual({
      action: "join",
      where: "Seven",
      disabled: false,
    });
  });

  it("offers watch for a full running match, and disables it without a server", () => {
    expect(describeRoom(room("a", "playing", 4, 4, { serverUrl: "wss://x" }))).toEqual({
      action: "watch",
      where: "Seven",
      disabled: false,
    });
    expect(describeRoom(room("a", "playing", 1, 4))).toEqual({ action: "watch", where: "Seven", disabled: true });
  });

  it("falls back to the map id when the map has no display name", () => {
    expect(describeRoom(room("a", "playing", 1, 4, { mapDisplayName: undefined })).where).toBe("wdm7");
  });
});

describe("playKeys", () => {
  const base = {
    modeTitle: "Duel",
    available: true,
    connected: true,
    queuePending: false,
    privateLobbySupported: true,
  };

  it("enables both keys when the mode is offered and the lobby is up", () => {
    expect(playKeys(base)).toEqual({
      find: { disabled: false, label: "Find Duel" },
      private: { disabled: false, title: "Create an invite-only room." },
    });
  });

  it("says Joining… while a queue request is pending", () => {
    const keys = playKeys({ ...base, queuePending: true });
    expect(keys.find).toEqual({ disabled: true, label: "Joining…" });
    expect(keys.private.disabled).toBe(true);
  });

  it("says the lobby is offline when disconnected", () => {
    expect(playKeys({ ...base, connected: false }).find).toEqual({ disabled: true, label: "Lobby offline" });
  });

  it("says the servers are full when the lobby turned this player away", () => {
    expect(playKeys({ ...base, connected: false, lobbyFull: true }).find).toEqual({
      disabled: true,
      label: "Servers full",
    });
  });

  it("marks a mode the lobby does not run as coming soon", () => {
    const keys = playKeys({ ...base, available: false });
    expect(keys.find).toEqual({ disabled: true, label: "Duel soon" });
    expect(keys.private).toEqual({ disabled: true, title: "This mode is not offered by the lobby server." });
  });

  it("disables private rooms on a lobby server without them, and says so first", () => {
    expect(playKeys({ ...base, privateLobbySupported: false, available: false }).private).toEqual({
      disabled: true,
      title: "This lobby server does not offer private rooms.",
    });
    expect(playKeys({ ...base, privateLobbySupported: false }).find.disabled).toBe(false);
  });
});
