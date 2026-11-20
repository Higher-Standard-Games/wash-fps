// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LobbyClient } from "../../../../lobby/LobbyClient";
import { BUILT_IN_REGIONS, LOCAL_REGION, resetActiveRegionForTests, setActiveRegion } from "../hosted/Regions";
import { JoinLobbyDialog } from "../JoinLobbyDialog";
import { inThisRegion, parseRoomCode, roomCode, roomInText } from "../LobbyCode";

const [EU, US] = BUILT_IN_REGIONS;
const REGIONS = [...BUILT_IN_REGIONS, LOCAL_REGION];
const INVITE = "q".repeat(32);

afterEach(() => {
  resetActiveRegionForTests();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("room codes", () => {
  it("write the region, the room and a private room's invite", () => {
    expect(roomCode("3fa9c2d1", null, EU)).toBe("eu:3fa9c2d1");
    expect(roomCode("3fa9c2d1", INVITE, US)).toBe(`us:3fa9c2d1:${INVITE}`);
    expect(roomCode("3fa9c2d1", undefined, null)).toBe("3fa9c2d1");
  });

  it("read codes with a region, without one, and with an invite", () => {
    expect(parseRoomCode("eu:3fa9c2d1", REGIONS)).toEqual({
      kind: "room",
      room: { region: EU, lobbyId: "3fa9c2d1" },
    });
    expect(parseRoomCode(` US:3fa9c2d1:${INVITE} `, REGIONS)).toEqual({
      kind: "room",
      room: { region: US, lobbyId: "3fa9c2d1", inviteToken: INVITE },
    });
    expect(parseRoomCode("3fa9c2d1", REGIONS)).toEqual({ kind: "room", room: { region: null, lobbyId: "3fa9c2d1" } });
  });

  it("read room links from a region's site, and tell another site's apart", () => {
    expect(parseRoomCode(`https://us.washoi.net/?lobby=3fa9c2d1&invite=${INVITE}`, REGIONS)).toEqual({
      kind: "room",
      room: { region: US, lobbyId: "3fa9c2d1", inviteToken: INVITE },
    });
    expect(parseRoomCode("https://eu.washoi.net/lobby/3fa9c2d1", REGIONS)).toEqual({
      kind: "room",
      room: { region: EU, lobbyId: "3fa9c2d1" },
    });
    expect(parseRoomCode("https://example.com/?lobby=3fa9c2d1", REGIONS, "eu.washoi.net")).toEqual({
      kind: "elsewhere",
      host: "example.com",
    });
  });

  it("refuse anything else", () => {
    for (const text of ["", "eu:", "eu:a:b:c", "hello world", "eu:<script>", "https://eu.washoi.net/"]) {
      expect(parseRoomCode(text, REGIONS)).toBeNull();
    }
  });

  it("find a room in a chat message only by a link or a code with its region", () => {
    expect(roomInText("join me: eu:3fa9c2d1!", REGIONS)?.lobbyId).toBe("3fa9c2d1");
    expect(roomInText("go https://us.washoi.net/?lobby=3fa9c2d1.", REGIONS)?.region).toBe(US);
    expect(roomInText("3fa9c2d1 is a nice number", REGIONS)).toBeNull();
    expect(roomInText("ratio 3:1", REGIONS)).toBeNull();
  });

  it("know which rooms are in this client's region", () => {
    setActiveRegion(EU, REGIONS);
    expect(inThisRegion({ region: null, lobbyId: "a" })).toBe(true);
    expect(inThisRegion({ region: EU, lobbyId: "a" })).toBe(true);
    expect(inThisRegion({ region: US, lobbyId: "a" })).toBe(false);
  });
});

describe("the Join lobby dialog", () => {
  function open(text?: string) {
    const joinLobby = vi.fn();
    const onClose = vi.fn();
    const dialog = new JoinLobbyDialog({ client: { joinLobby } as unknown as LobbyClient, onClose, text });
    const key = () =>
      [...dialog.root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        /Join|Switch/.test(b.textContent ?? ""),
      )!;
    return { dialog, joinLobby, onClose, key };
  }

  it("joins a room in this region, invite included", () => {
    setActiveRegion(EU, REGIONS);
    const { dialog, joinLobby, onClose, key } = open(`eu:3fa9c2d1:${INVITE}`);
    expect(dialog.root.textContent).toContain("Room 3fa9c2d1 (private).");
    key().click();
    expect(joinLobby).toHaveBeenCalledWith("3fa9c2d1", INVITE);
    expect(onClose).toHaveBeenCalled();
    dialog.destroy();
  });

  it("says when a room is in another region, and offers to switch", () => {
    setActiveRegion(EU, REGIONS);
    const { dialog, joinLobby, key } = open("us:3fa9c2d1");
    expect(dialog.root.textContent).toContain("That room is in North America");
    expect(key().textContent).toContain("Switch to US");
    expect(joinLobby).not.toHaveBeenCalled();
    dialog.destroy();
  });

  it("keeps Join off until the text names a room", () => {
    const { dialog, key } = open("not a room");
    expect(key().disabled).toBe(true);
    expect(dialog.root.textContent).toContain("Paste a room link, or a code like eu:3fa9c2d1.");
    dialog.destroy();
  });
});
