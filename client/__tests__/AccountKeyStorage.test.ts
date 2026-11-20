// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { logIn, resetAccountSessionForTests, restoreAccount, storedPlayerKey } from "../../../../lobby/AccountSession";
import type { LobbyClient } from "../../../../lobby/LobbyClient";
import { formatKey } from "../../../../lobby/PlayerIdentity";
import { ProfileView } from "../ProfileView";
import { WelcomeOverlay } from "../WelcomeOverlay";

let profile: ProfileView | undefined;
let welcome: WelcomeOverlay | undefined;
afterEach(() => {
  profile?.destroy();
  welcome?.destroy();
  profile = undefined;
  welcome = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetAccountSessionForTests();
  document.body.replaceChildren();
});

function client(accountId = "1", key = "A".repeat(24)): LobbyClient {
  const listeners = new Map<string, Set<(message: unknown) => void>>();
  return {
    connected: true,
    on(type: string, receive: (message: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(receive);
      return () => listeners.get(type)!.delete(receive);
    },
    auth() {
      queueMicrotask(() => {
        for (const receive of listeners.get("welcome") ?? [])
          receive({ type: "welcome", key, identity: { id: accountId, name: `Player_${accountId}` } });
      });
    },
    rename() {},
  } as unknown as LobbyClient;
}

describe("session-only account keys", () => {
  it("hides a revealed Profile key on close and reopen, while keeping copy available", async () => {
    const lobby = client();
    await logIn(lobby);
    profile = new ProfileView({ client: lobby, isInRoom: () => false, modes: () => [] });
    profile.open(document.body);
    const reveal = profile.root.querySelector<HTMLButtonElement>(".keyplate__reveal")!;
    reveal.click();
    expect(reveal.getAttribute("aria-pressed")).toBe("true");
    profile.refresh();
    expect(reveal.getAttribute("aria-pressed")).toBe("true");
    profile.close();
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    profile.open(document.body);
    expect(profile.root.querySelector(".keyplate")?.classList.contains("keyplate--hidden")).toBe(true);
    reveal.click();
    await restoreAccount(client("2", "B".repeat(24)), "B".repeat(24));
    profile.refresh();
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    expect(profile.root.querySelector(".keyplate")?.classList.contains("keyplate--hidden")).toBe(true);
  });
  it("explains failed persistence on welcome and keeps Profile copy/export controls usable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    const lobby = client();
    await logIn(lobby);
    welcome = new WelcomeOverlay(() => {});
    welcome.open(document.body);
    expect(welcome.root.textContent).toContain("open Profile and copy or save your key before reloading");
    profile = new ProfileView({ client: lobby, isInRoom: () => false, modes: () => [] });
    profile.open(document.body);
    const notice = [...profile.root.querySelectorAll<HTMLElement>("[role=status]")].find((node) =>
      node.textContent?.includes("before reloading"),
    )!;
    expect(notice.hidden).toBe(false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const copy = [...profile.root.querySelectorAll<HTMLButtonElement>("button")].find((key) =>
      key.textContent?.includes("Copy key"),
    )!;
    expect(copy.disabled).toBe(false);
    expect(copy.parentElement?.hidden).toBe(false);
    copy.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(formatKey(storedPlayerKey()!)));
  });
});
