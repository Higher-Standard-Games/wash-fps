// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { FPSPauseMenu } from "../hud/widgets/PauseMenu";
import { returnToLobby } from "../ReturnToLobby";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  document.body.replaceChildren();
});

it("constructs the match menu and opens Play when session storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  const menu = new FPSPauseMenu();
  expect(document.body.textContent).toContain("Leave match");
  menu.destroy();
  const navigate = vi.fn();
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  returnToLobby(navigate);
  expect(navigate).toHaveBeenCalledWith(new URL(window.location.origin).href);
});

it("returns to main Play without rejoining the old private room", () => {
  sessionStorage.setItem("shag.return_lobby", "room-one");
  sessionStorage.setItem("shag.private_invite.room-one", "test-invite");
  const navigate = vi.fn();
  returnToLobby(navigate);
  const url = new URL(navigate.mock.calls[0][0]);
  expect(url.href).toBe(new URL(window.location.origin).href);
  expect(sessionStorage.getItem("shag.return_lobby")).toBeNull();
  expect(sessionStorage.getItem("shag.private_invite.room-one")).toBe("test-invite");
});
