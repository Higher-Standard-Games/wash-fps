// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { InputSystem } from "../../../../engine/input/InputSystem";
import { DEFAULT_FPS_MOVEMENT_CONFIG } from "../../simulation/MovementProfile";
import { FPS, registerFPSActions } from "../FPSActions";
import { LobbyPanel } from "../LobbyPanel";
import { TERMS_PREFERENCE, TERMS_VERSION, WELCOME_PREFERENCE, welcomeIsHidden } from "../LobbyWelcomeDialog";
import { LobbyWelcomeGuide, type WelcomeBootState } from "../LobbyWelcomeGuide";

let root: HTMLElement, guide: LobbyWelcomeGuide, state: WelcomeBootState, blocked: boolean, playPage: boolean;
const finished = vi.fn(),
  prepare = vi.fn();
const input = InputSystem.getInstance();
const dialog = () => document.querySelector<HTMLElement>(".lobby-guide");
const next = () => (document.querySelector(".lobby-guide__next") as HTMLButtonElement).click();
function start(): void {
  guide.show();
  guide.setAuthenticated(true);
  guide.initialLoadingDismissed();
}
beforeEach(() => {
  Cvar.init();
  registerFPSActions();
  input.resetAllBindings();
  input.setContext("gameplay");
  localStorage.clear();
  localStorage.setItem(TERMS_PREFERENCE, TERMS_VERSION);
  document.body.replaceChildren();
  document.body.style.overflow = "auto";
  root = document.createElement("div");
  document.body.append(root);
  state = { initialReady: false, completed: false };
  blocked = false;
  playPage = true;
  finished.mockReset();
  prepare.mockClear();
  guide = new LobbyWelcomeGuide(
    {
      root,
      canOpen: () => !blocked,
      showHelp: () => playPage,
      prepareOpen: prepare,
      openControls: (back) => root.append(back),
      finished,
    },
    state,
  );
});
afterEach(() => {
  guide.destroy();
  input.resetAllBindings();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

describe("the terms of service on the guide's first page", () => {
  const agree = () => document.querySelector<HTMLInputElement>(".lobby-guide__agree input")!;
  const nextKey = () => document.querySelector<HTMLButtonElement>(".lobby-guide__next")!;
  const pressEscape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  it("shows the terms and holds the player on them until they agree", () => {
    localStorage.removeItem(TERMS_PREFERENCE);
    start();
    expect(TERMS_VERSION).toBe("October 21, 2026");
    expect(document.querySelector(".lobby-guide__terms h3")?.textContent).toBe("Terms of Service");
    expect(agree().checked).toBe(false);
    expect(nextKey().disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#lobby-guide-tab-1")!.disabled).toBe(true);
    pressEscape();
    expect(dialog()).not.toBeNull();
    expect(finished).not.toHaveBeenCalled();

    agree().click();
    expect(localStorage.getItem(TERMS_PREFERENCE)).toBe(TERMS_VERSION);
    expect(nextKey().disabled).toBe(false);
    next();
    expect(document.querySelector<HTMLElement>("#lobby-guide-panel-1")!.hidden).toBe(false);
  });

  it("asks again when the terms change, even with the guide turned off", () => {
    localStorage.setItem(WELCOME_PREFERENCE, "true");
    expect(welcomeIsHidden()).toBe(true);
    localStorage.setItem(TERMS_PREFERENCE, "January 1, 2026");
    expect(welcomeIsHidden()).toBe(false);
    start();
    expect(dialog()).not.toBeNull();
    expect(agree().checked).toBe(false);
  });

  it("remembers an earlier agreement", () => {
    start();
    expect(agree().checked).toBe(true);
    expect(nextKey().disabled).toBe(false);
    pressEscape();
    expect(finished).toHaveBeenCalledTimes(1);
  });
});

describe("lobby welcome lifecycle", () => {
  it("only exposes manual help on Play without blocking the Controls detour", () => {
    start();
    next();
    document.querySelector<HTMLButtonElement>(".lobby-guide__setup")!.click();
    playPage = false;
    guide.refresh();
    expect(guide.help.hidden).toBe(true);
    guide.resume();
    expect(dialog()).not.toBeNull();
    next();
    next();
    guide.help.click();
    expect(dialog()).toBeNull();
    playPage = true;
    guide.refresh();
    expect(guide.help.hidden).toBe(false);
    guide.help.click();
    expect(dialog()).not.toBeNull();
  });
  it("defers the real invitation join until the guide is complete", () => {
    const previousUrl = location.href;
    history.replaceState({}, "", "/?lobby=test-room&invite=secret-token");
    const joinLobby = vi.fn();
    const panel = Object.assign(Object.create(LobbyPanel.prototype), {
      welcomeGuide: guide,
      lobbyClient: { connected: true, joinLobby },
      urlLobbyJoinAttempted: false,
      destroyed: false,
    }) as { runDeepLinkJoin(): void };
    finished.mockImplementation(() => panel.runDeepLinkJoin());
    try {
      start();
      panel.runDeepLinkJoin();
      expect(joinLobby).not.toHaveBeenCalled();
      next();
      next();
      next();
      panel.runDeepLinkJoin();
      expect(joinLobby).toHaveBeenCalledExactlyOnceWith("test-room", "secret-token");
    } finally {
      history.replaceState({}, "", previousUrl);
      sessionStorage.clear();
    }
  });
  it("treats malformed or denied storage as automatic display enabled", () => {
    localStorage.setItem(WELCOME_PREFERENCE, "not-a-boolean");
    expect(welcomeIsHidden()).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    start();
    expect(dialog()).not.toBeNull();
  });
  it("waits for initial splash dismissal, authentication and identity setup, then opens once", () => {
    guide.show();
    guide.initialLoadingDismissed();
    expect(dialog()).toBeNull();
    blocked = true;
    guide.setAuthenticated(true);
    expect(dialog()).toBeNull();
    blocked = false;
    guide.refresh();
    expect(dialog()).not.toBeNull();
    guide.setAuthenticated(true);
    guide.refresh();
    expect(document.querySelectorAll(".lobby-guide")).toHaveLength(1);
    expect(guide.readyForJoin).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(guide.readyForJoin).toBe(true);
    expect(finished).toHaveBeenCalledTimes(1);
    guide.leaveLobby();
    guide.show();
    guide.setAuthenticated(true);
    expect(dialog()).toBeNull();
  });
  it("waits for splash even if login completes first", () => {
    guide.show();
    guide.setAuthenticated(true);
    expect(dialog()).toBeNull();
    guide.initialLoadingDismissed();
    expect(dialog()).not.toBeNull();
  });
  it("recovers after disconnect without stacking overlays", () => {
    start();
    next();
    guide.setAuthenticated(false);
    expect(dialog()).toBeNull();
    expect(root.inert).not.toBe(true);
    guide.setAuthenticated(true);
    expect(dialog()?.querySelector('[aria-selected="true"]')?.textContent).toContain("Your keys");
  });
  it("never consumes a pending join until completion, and permits manual reopening", () => {
    start();
    next();
    next();
    expect(finished).not.toHaveBeenCalled();
    next();
    expect(finished).toHaveBeenCalledTimes(1);
    expect(guide.readyForJoin).toBe(true);
    guide.help.click();
    expect(dialog()).not.toBeNull();
    expect(guide.readyForJoin).toBe(false);
    next();
    next();
    next();
    expect(guide.readyForJoin).toBe(true);
  });
  it("persists opt-out, still opens from help, and can reenable startup display", () => {
    localStorage.setItem(WELCOME_PREFERENCE, "true");
    start();
    expect(dialog()).toBeNull();
    expect(state.completed).toBe(true);
    expect(finished).toHaveBeenCalledTimes(1);
    guide.help.click();
    next();
    next();
    const checkbox = dialog()!.querySelector<HTMLInputElement>(
      ".lobby-guide__preference:not(.lobby-guide__agree) input",
    )!;
    expect(checkbox.checked).toBe(true);
    checkbox.click();
    expect(localStorage.getItem(WELCOME_PREFERENCE)).toBe("false");
    next();
    state.initialReady = false;
    state.completed = false;
    guide.initialLoadingDismissed();
    expect(dialog()).not.toBeNull();
  });
  it("closing alone doesn't mute and denied storage shows accurate feedback", () => {
    start();
    next();
    next();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    dialog()!.querySelector<HTMLInputElement>(".lobby-guide__preference:not(.lobby-guide__agree) input")!.click();
    expect(dialog()?.textContent).toContain("couldn't be saved");
    expect(localStorage.getItem(WELCOME_PREFERENCE)).toBeNull();
    next();
    expect(document.body.style.overflow).toBe("auto");
    expect(input.getActiveContext()).toBe("gameplay");
  });
  it("returns from Controls with updated bindings and no editable preview controls", () => {
    start();
    next();
    expect(dialog()?.querySelectorAll(".lobby-guide__preview button")).toHaveLength(0);
    (dialog()!.querySelector(".lobby-guide__setup") as HTMLButtonElement).click();
    expect(guide.suspended).toBe(true);
    expect(dialog()).toBeNull();
    expect(root.inert).not.toBe(true);
    input.rebind(FPS.JUMP, [{ key: "KeyQ" }]);
    input.rebind(FPS.CROUCH, []);
    (root.querySelector(".lobby-guide-back") as HTMLButtonElement).click();
    expect(dialog()?.querySelector('[data-code="KeyQ"]')?.getAttribute("aria-label")).toContain("Jump");
    next();
    expect(dialog()?.querySelector("#lobby-guide-panel-2")?.textContent).toContain("Crouch is unbound");
    expect(dialog()?.querySelector("#lobby-guide-panel-2")?.textContent).toContain(
      String(DEFAULT_FPS_MOVEMENT_CONFIG.slideMinSpeed),
    );
    expect(dialog()?.querySelector("#lobby-guide-panel-2")?.textContent).toContain("Q");
  });
  it("traps focus and supports tab arrows without leaking lobby shortcuts", () => {
    start();
    const tabs = dialog()!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    const listener = vi.fn();
    document.addEventListener("keydown", listener);
    tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "w", bubbles: true }));
    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener("keydown", listener);
    const outsider = document.createElement("button");
    root.append(outsider);
    outsider.focus();
    expect(dialog()?.contains(document.activeElement)).toBe(true);
    const close = dialog()!.querySelector<HTMLButtonElement>(".lobby-guide__next")!;
    close.focus();
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(tabs[1]);
  });
  it("activates Next/Close with Enter and the checkbox with Space", () => {
    start();
    const activate = (key: string, target: HTMLElement) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    let nextKey = dialog()!.querySelector<HTMLButtonElement>(".lobby-guide__next")!;
    activate("Enter", nextKey);
    activate("Enter", nextKey);
    const checkbox = dialog()!.querySelector<HTMLInputElement>(
      ".lobby-guide__preference:not(.lobby-guide__agree) input",
    )!;
    activate(" ", checkbox);
    expect(localStorage.getItem(WELCOME_PREFERENCE)).toBe("true");
    nextKey = dialog()!.querySelector<HTMLButtonElement>(".lobby-guide__next")!;
    activate("Enter", nextKey);
    expect(dialog()).toBeNull();
  });
  it("cleans blur, focus hooks and input context on destruction or map transition", () => {
    start();
    expect(root.inert).toBe(true);
    expect(root.classList.contains("lobby-guide-background")).toBe(true);
    guide.leaveLobby();
    expect(dialog()).toBeNull();
    expect(root.inert).not.toBe(true);
    expect(root.classList.contains("lobby-guide-background")).toBe(false);
    expect(guide.help.hidden).toBe(true);
    guide.show();
    expect(dialog()).toBeNull();
    guide.help.click();
    expect(dialog()).not.toBeNull();
    guide.destroy();
    expect(dialog()).toBeNull();
    expect(input.getActiveContext()).toBe("gameplay");
  });
});
