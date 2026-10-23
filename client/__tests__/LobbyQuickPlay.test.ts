// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LobbyPanel } from "../LobbyPanel";

vi.mock("../FpsLobbyService", () => ({ ensureFpsLobbyConnection: vi.fn(), getFpsLobbyClient: vi.fn() }));
vi.mock("../DemoService", () => ({ DemoService: { getInstance: () => ({ setLobbyClient: vi.fn() }) } }));

interface QuickPlayPanel {
  quickPlayKey: HTMLButtonElement;
  lobbyClient: { connected: boolean; createLobby: ReturnType<typeof vi.fn> };
  privateLobbySupported: boolean;
  queuePending: boolean;
  pendingPrivateCreate: boolean;
  pendingQuickPlay: boolean;
  currentLobbyId: string | null;
  serverGametypes: Array<{ id: string }>;
  switchTab: ReturnType<typeof vi.fn>;
  startQuickPlay(): void;
  refreshQuickPlayKey(): void;
}

function quickPlayPanel(overrides: Partial<QuickPlayPanel> = {}): QuickPlayPanel {
  return Object.assign(Object.create(LobbyPanel.prototype), {
    quickPlayKey: document.createElement("button"),
    lobbyClient: { connected: true, createLobby: vi.fn() },
    privateLobbySupported: true,
    queuePending: false,
    pendingPrivateCreate: false,
    pendingQuickPlay: false,
    currentLobbyId: null,
    serverGametypes: [{ id: "duel" }, { id: "ffa" }],
    playNoticeEl: null,
    switchTab: vi.fn(),
    refreshModeAvailability: vi.fn(),
    ...overrides,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("quick play", () => {
  it("opens the Play page and asks for a private FFA room it will fill with bots", () => {
    const panel = quickPlayPanel();
    panel.startQuickPlay();
    expect(panel.switchTab).toHaveBeenCalledWith("matchmaking");
    expect(panel.lobbyClient.createLobby).toHaveBeenCalledWith("ffa", "private");
    expect(panel.pendingQuickPlay).toBe(true);
  });

  it("asks for nothing while another room is being requested", () => {
    const panel = quickPlayPanel({ queuePending: true });
    panel.startQuickPlay();
    expect(panel.lobbyClient.createLobby).not.toHaveBeenCalled();
    expect(panel.pendingQuickPlay).toBe(false);
  });

  it("is off offline, in a room, without private rooms, or without FFA", () => {
    for (const [overrides, disabled] of [
      [{}, false],
      [{ lobbyClient: { connected: false, createLobby: vi.fn() } }, true],
      [{ currentLobbyId: "room" }, true],
      [{ privateLobbySupported: false }, true],
      [{ serverGametypes: [{ id: "duel" }] }, true],
    ] as const) {
      const panel = quickPlayPanel(overrides as Partial<QuickPlayPanel>);
      panel.refreshQuickPlayKey();
      expect(panel.quickPlayKey.disabled).toBe(disabled);
    }
  });
});
