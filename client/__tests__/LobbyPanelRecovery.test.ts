// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as AccountSession from "../../../../lobby/AccountSession";
import { LoginError } from "../../../../lobby/AccountSession";
import { ensureFpsLobbyConnection } from "../FpsLobbyService";
import { LobbyPanel } from "../LobbyPanel";

vi.mock("../FpsLobbyService", () => ({ ensureFpsLobbyConnection: vi.fn(), getFpsLobbyClient: vi.fn() }));
vi.mock("../DemoService", () => ({ DemoService: { getInstance: () => ({ setLobbyClient: vi.fn() }) } }));

interface RecoveryPanel {
  root: HTMLElement;
  loginAttempt: Promise<void> | null;
  loginFailures: number;
  destroyed: boolean;
  lobbyFullNotice: { close(): void; isFull: boolean } | null;
  lobbyClient: {
    joinLobby: ReturnType<typeof vi.fn>;
    connected: boolean;
    on(type: string, receive: (message: never) => void): () => void;
  };
  currentLobbyId: string | null;
  currentInviteToken: string | undefined;
  roomToRejoin: { lobbyId: string; inviteToken?: string; accountId: string } | null;
  chatMessagesEl: HTMLElement;
  logInToLobby(): Promise<void>;
  initLobbyConnection(): Promise<void>;
  restoreRoom(accountId: string): void;
  showChatEmpty(): void;
}
let panel: RecoveryPanel;
let listeners: Map<string, (message: never) => void>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  listeners = new Map();
  panel = Object.assign(Object.create(LobbyPanel.prototype), {
    root: document.createElement("div"),
    loginAttempt: null,
    loginFailures: 0,
    destroyed: false,
    lobbyFullNotice: null,
    roomToRejoin: null,
    lobbyClient: {
      joinLobby: vi.fn(),
      connected: false,
      on(type: string, receive: (message: never) => void) {
        listeners.set(type, receive);
        return () => listeners.delete(type);
      },
    },
    unsubscribers: [],
    currentLobbyId: null,
    currentInviteToken: undefined,
    chatMessagesEl: document.createElement("div"),
    refreshPlayerCard: vi.fn(),
    showDisconnectedState: vi.fn(),
    runDeepLinkJoin: vi.fn(),
    showWelcome: vi.fn(),
    refreshModeAvailability: vi.fn(),
    refreshMatchList: vi.fn(),
    refreshPlayerList: vi.fn(),
    _preloadLevelshots: vi.fn(),
  });
  document.body.append(panel.root);
  vi.mocked(ensureFpsLobbyConnection).mockReset();
});
afterEach(() => {
  panel.lobbyFullNotice?.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("lobby recovery", () => {
  it("captures the private invite on connection loss and rejoins on the next welcome", async () => {
    vi.spyOn(AccountSession, "currentIdentity").mockReturnValue({ id: "one", name: "Test" });
    vi.mocked(ensureFpsLobbyConnection).mockResolvedValue(undefined as never);
    await panel.initLobbyConnection();
    panel.currentLobbyId = "private-room";
    panel.currentInviteToken = "test-invite";
    listeners.get("_disconnected")!({} as never);
    expect(panel.roomToRejoin).toEqual({ lobbyId: "private-room", inviteToken: "test-invite", accountId: "one" });
    expect(panel.root.textContent).toContain("Lobby offline");
    await vi.advanceTimersByTimeAsync(2000);
    panel.lobbyClient.connected = true;
    listeners.get("welcome")!({ playerId: "new-connection", identity: { id: "one", name: "Test" } } as never);
    expect(panel.lobbyClient.joinLobby).toHaveBeenCalledExactlyOnceWith("private-room", "test-invite");
    expect(panel.root.textContent).not.toContain("Lobby offline");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("leaves a close this client made itself (an account switch) to its own reconnect", async () => {
    vi.mocked(ensureFpsLobbyConnection).mockResolvedValue(undefined as never);
    await panel.initLobbyConnection();
    listeners.get("_disconnected")!({ reason: "Client disconnect", code: 1000 } as never);
    expect(panel.root.textContent).not.toContain("Lobby offline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ensureFpsLobbyConnection).toHaveBeenCalledTimes(1);
  });

  it("retries an outage, deduplicates in-flight attempts, and closes the notice on success", async () => {
    vi.mocked(ensureFpsLobbyConnection).mockRejectedValueOnce(new Error("offline"));
    await panel.logInToLobby();
    expect(panel.root.textContent).toContain("Lobby offline");
    expect(panel.lobbyFullNotice?.isFull).toBe(false);
    let resolve!: (client: never) => void;
    vi.mocked(ensureFpsLobbyConnection).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    const pending = panel.logInToLobby();
    expect(ensureFpsLobbyConnection).toHaveBeenCalledTimes(2);
    resolve(undefined as never);
    await pending;
    expect(panel.root.textContent).not.toContain("Lobby offline");
    expect(panel.loginFailures).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the server's full-lobby wait and supports Try now", async () => {
    vi.mocked(ensureFpsLobbyConnection).mockRejectedValue(new LoginError("lobby_full", 60));
    await panel.initLobbyConnection();
    expect(panel.lobbyFullNotice?.isFull).toBe(true);
    listeners.get("_disconnected")!({} as never);
    expect(panel.lobbyFullNotice?.isFull).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ensureFpsLobbyConnection).toHaveBeenCalledTimes(1);
    panel.root.querySelector<HTMLButtonElement>("button")!.click();
    await panel.loginAttempt;
    expect(ensureFpsLobbyConnection).toHaveBeenCalledTimes(2);
    // A later retry can encounter a real outage instead of a capacity refusal.
    vi.mocked(ensureFpsLobbyConnection).mockRejectedValue(new Error("offline"));
    panel.root.querySelector<HTMLButtonElement>("button")!.click();
    await panel.loginAttempt;
    expect(panel.lobbyFullNotice?.isFull).toBe(false);
    expect(panel.root.textContent).toContain("Lobby offline");
  });

  it("does not resurrect a destroyed panel after a pending login fails", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(ensureFpsLobbyConnection).mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
    const pending = panel.logInToLobby();
    panel.destroyed = true;
    reject(new Error("offline"));
    await pending;
    expect(panel.lobbyFullNotice).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores a private room only for the original account", () => {
    const room = { lobbyId: "room", inviteToken: "test-invite", accountId: "one" };
    panel.roomToRejoin = room;
    panel.restoreRoom("two");
    expect(panel.lobbyClient.joinLobby).not.toHaveBeenCalled();
    panel.roomToRejoin = room;
    panel.restoreRoom("one");
    expect(panel.lobbyClient.joinLobby).toHaveBeenCalledExactlyOnceWith("room", "test-invite");
    expect(panel.roomToRejoin).toBeNull();
  });

  it("updates the empty chat message when going offline", () => {
    panel.lobbyClient.connected = true;
    panel.showChatEmpty();
    expect(panel.chatMessagesEl.textContent).toContain("Say hello");
    panel.lobbyClient.connected = false;
    panel.showChatEmpty();
    expect(panel.chatMessagesEl.textContent).toBe("Chat opens when the lobby server is back.");
    expect(panel.chatMessagesEl.childElementCount).toBe(1);
  });
});
