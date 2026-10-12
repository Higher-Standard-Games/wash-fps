// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { FPSPauseMenu } from "../hud/widgets/PauseMenu";
import { returnToLobby } from "../ReturnToLobby";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  document.body.replaceChildren();
});

it("constructs the match menu and falls back to reload when session storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  const menu = new FPSPauseMenu();
  expect(document.body.textContent).toContain("Leave match");
  menu.destroy();
  const navigate = vi.fn();
  const reload = vi.fn();
  returnToLobby(navigate, reload);
  expect(navigate).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledOnce();
});

it("returns to the private room and falls back safely if reading its invite fails", () => {
  sessionStorage.setItem("shag.return_lobby", "room-one");
  sessionStorage.setItem("shag.private_invite.room-one", "test-invite");
  const navigate = vi.fn();
  const reload = vi.fn();
  returnToLobby(navigate, reload);
  const url = new URL(navigate.mock.calls[0][0]);
  expect(url.searchParams.get("lobby")).toBe("room-one");
  expect(url.searchParams.get("invite")).toBe("test-invite");
  expect(reload).not.toHaveBeenCalled();
  const read = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
    if (key.startsWith("shag.private_invite")) throw new Error("Storage blocked");
    return read.call(this, key);
  });
  navigate.mockClear();
  returnToLobby(navigate, reload);
  expect(navigate).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledOnce();
});
