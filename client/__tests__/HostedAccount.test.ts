// @vitest-environment jsdom
/**
 * A hosted build's account: the key stays in memory and is shown in the
 * session that made it; later sessions log in with a stored token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { InputSystem } from "../../../../engine/input/InputSystem";
import {
  endedLoginReason,
  keyKeptElsewhere,
  keyToSaveNow,
  logIn,
  resetAccountSessionForTests,
  restoreAccount,
  setUpHostedLogin,
  storedPlayerKey,
} from "../../../../lobby/AccountSession";
import type { LobbyClient } from "../../../../lobby/LobbyClient";
import { registerFPSActions } from "../FPSActions";
import { TERMS_PREFERENCE, TERMS_VERSION } from "../LobbyWelcomeDialog";
import { LobbyWelcomeGuide } from "../LobbyWelcomeGuide";
import { ProfileView } from "../ProfileView";
import { WelcomeOverlay } from "../WelcomeOverlay";

const KEY = "A".repeat(24);
type Auth = { key?: string; hosted?: { host: string; token?: string } };

/** A lobby that answers each auth with `answer`, recording what was sent. */
function lobby(answer: (auth: Auth) => Record<string, unknown>): LobbyClient & { auths: Auth[] } {
  const listeners = new Map<string, Set<(message: unknown) => void>>();
  const auths: Auth[] = [];
  return {
    connected: true,
    auths,
    on(type: string, receive: (message: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(receive);
      return () => listeners.get(type)!.delete(receive);
    },
    auth(key?: string, hosted?: { host: string; token?: string }) {
      auths.push({ key, hosted });
      const message = answer({ key, hosted });
      queueMicrotask(() => {
        for (const receive of listeners.get(String(message.type)) ?? []) receive(message);
      });
    },
    rename() {},
  } as unknown as LobbyClient & { auths: Auth[] };
}

const welcome = (extra: Record<string, unknown>) => ({
  type: "welcome",
  identity: { id: "7", name: "Ramen" },
  ...extra,
});

/** A new session of the page: memory is gone, browser storage stays. */
function nextSession(): void {
  resetAccountSessionForTests();
  setUpHostedLogin("itch", "eu");
}

beforeEach(() => {
  localStorage.clear();
  resetAccountSessionForTests();
  setUpHostedLogin("itch", "eu");
});
let shownGuide: LobbyWelcomeGuide | null = null;

afterEach(() => {
  shownGuide?.destroy();
  shownGuide = null;
  InputSystem.getInstance().resetAllBindings();
  resetAccountSessionForTests();
  localStorage.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("hosted login", () => {
  it("keeps a new player's key in memory, stores only the token, and offers the key to save", async () => {
    const client = lobby(() => welcome({ key: KEY, token: "t1" }));
    await logIn(client);
    expect(client.auths[0]).toEqual({ key: undefined, hosted: { host: "itch", token: undefined } });
    expect(storedPlayerKey()).toBe(KEY);
    expect(keyToSaveNow()).toBe(KEY);
    expect(localStorage.getItem("shag_player_key")).toBeNull();
    expect(localStorage.getItem("shag_login_token:eu")).toBe("t1");
    expect(Object.values(localStorage).join(" ")).not.toContain(KEY);
  });

  it("logs the next session in with the token, replaces it, and has no key to show", async () => {
    await logIn(lobby(() => welcome({ key: KEY, token: "t1" })));
    nextSession();
    const client = lobby(() => welcome({ token: "t2" }));
    await logIn(client);
    expect(client.auths).toEqual([{ key: undefined, hosted: { host: "itch", token: "t1" } }]);
    expect(localStorage.getItem("shag_login_token:eu")).toBe("t2");
    expect(storedPlayerKey()).toBeNull();
    expect(keyKeptElsewhere()).toBe(true);
    expect(keyToSaveNow()).toBeNull();
  });

  it("keeps Profile's key panel in later sessions, with the key's place held and its actions off", async () => {
    await logIn(lobby(() => welcome({ key: KEY, token: "t1" })));
    nextSession();
    const client = lobby(() => welcome({ token: "t2" }));
    await logIn(client);
    const profile = new ProfileView({ client, isInRoom: () => false, modes: () => [] });
    profile.open(document.body);
    const plate = profile.root.querySelector<HTMLElement>(".keyplate")!;
    expect(plate.hidden).toBe(false);
    expect(plate.textContent).not.toContain("AAAA");
    expect(plate.querySelector(".keyplate__groups")?.textContent).toContain("••••");
    expect(plate.querySelector<HTMLElement>(".keyplate__reveal")?.hidden).toBe(true);
    const actions = [...profile.root.querySelectorAll<HTMLButtonElement>(".welcome__actions button")];
    expect(actions.length).toBeGreaterThan(1);
    expect(actions.every((action) => action.disabled)).toBe(true);
    const another = [...profile.root.querySelectorAll<HTMLButtonElement>("button")].find((k) =>
      /Use another key/.test(k.textContent ?? ""),
    );
    expect(another?.disabled).toBe(false);
    profile.destroy();
  });

  it("drops a refused token, makes a new player, and says why on welcome", async () => {
    localStorage.setItem("shag_login_token:eu", "copied");
    const client = lobby((auth) =>
      auth.hosted?.token ? { type: "auth:error", code: "token_reused" } : welcome({ key: KEY, token: "fresh" }),
    );
    await logIn(client);
    expect(client.auths).toHaveLength(2);
    expect(endedLoginReason()).toBe("token_reused");
    expect(localStorage.getItem("shag_login_token:eu")).toBe("fresh");
    const overlay = new WelcomeOverlay(() => {});
    overlay.open(document.body);
    expect(overlay.root.textContent).toContain("used somewhere else");
    expect(overlay.root.textContent).not.toContain("could not be saved");
    overlay.destroy();
  });

  it("gets a token for a pasted key, keeping the key for this session only", async () => {
    const client = lobby(() => welcome({ token: "t9" }));
    await restoreAccount(client, KEY);
    expect(client.auths[0]).toEqual({ key: KEY, hosted: { host: "itch", token: undefined } });
    expect(localStorage.getItem("shag_login_token:eu")).toBe("t9");
    expect(keyToSaveNow()).toBe(KEY);
    expect(localStorage.getItem("shag_player_key")).toBeNull();
  });

  it("keeps each region's token apart", async () => {
    await logIn(lobby(() => welcome({ key: KEY, token: "eu-token" })));
    resetAccountSessionForTests();
    setUpHostedLogin("itch", "us");
    const client = lobby(() => welcome({ key: "B".repeat(24), token: "us-token" }));
    await logIn(client);
    expect(client.auths[0].hosted?.token).toBeUndefined();
    expect(localStorage.getItem("shag_login_token:eu")).toBe("eu-token");
    expect(localStorage.getItem("shag_login_token:us")).toBe("us-token");
  });
});

describe("the welcome guide's key step", () => {
  function openGuide(): void {
    Cvar.init();
    registerFPSActions();
    InputSystem.getInstance().setContext("gameplay");
    localStorage.setItem(TERMS_PREFERENCE, TERMS_VERSION);
    const root = document.createElement("div");
    document.body.append(root);
    const guide = new LobbyWelcomeGuide(
      {
        root,
        canOpen: () => true,
        showHelp: () => true,
        prepareOpen: vi.fn(),
        openControls: vi.fn(),
        finished: vi.fn(),
      },
      { initialReady: false, completed: false },
    );
    shownGuide = guide;
    guide.show();
    guide.setAuthenticated(true);
    guide.initialLoadingDismissed();
  }
  const steps = () => [...document.querySelectorAll(".lobby-guide__step-name")].map((step) => step.textContent);

  it("ends with Your account while the key is in this session", async () => {
    await logIn(lobby(() => welcome({ key: KEY, token: "t1" })));
    openGuide();
    expect(steps()).toEqual(["Terms of service", "Your keys", "Tip of the day", "Your account"]);
    const plate = document.querySelector(".lobby-guide__key")!;
    expect(plate.textContent).toContain("AAAA");
    // Blurred until the player asks to see it
    expect(plate.classList.contains("lobby-guide__key--hidden")).toBe(true);
    plate.querySelector<HTMLButtonElement>(".lobby-guide__key-reveal")!.click();
    expect(plate.classList.contains("lobby-guide__key--hidden")).toBe(false);
  });

  it("has no key step once a hosted build's key has gone", async () => {
    localStorage.setItem("shag_login_token:eu", "t1");
    await logIn(lobby(() => welcome({ token: "t2" })));
    openGuide();
    expect(steps()).toEqual(["Terms of service", "Your keys", "Tip of the day"]);
  });

  it("keeps the key step on a region's own site, which stores the key, with its own wording", async () => {
    resetAccountSessionForTests();
    await logIn(lobby(() => welcome({ key: KEY })));
    openGuide();
    expect(steps()).toEqual(["Terms of service", "Your keys", "Tip of the day", "Your account"]);
    const step = document.querySelector(".lobby-guide__key")!.closest("section")!;
    expect(step.textContent).toContain("Keep a copy somewhere safe");
    expect(step.textContent).not.toContain("only until you leave");
  });
});
