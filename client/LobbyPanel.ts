/**
 * LobbyPanel — Main Lobby UI (extends GamePanel)
 *
 * Full-screen rail navigation, Play stage, and server-backed lobby data.
 */

import { EngineVersion } from "../../../engine/core/EngineVersion";
import { DebugConsole } from "../../../engine/debug/DebugConsole";
import { PlayerProfile } from "../../../engine/player/PlayerProfile";
import { ConnectingOverlay } from "../../../engine/ui/components/ConnectingOverlay";
import { MatchLobbyView } from "../../../engine/ui/components/MatchLobbyView";
import {
  createRaisedKey,
  injectRaisedKeyStyles,
  raiseKey,
  setRaisedKeyText,
} from "../../../engine/ui/components/RaisedKey";
import matchLobbyCSSRaw from "../../../engine/ui/components/styles/MatchLobbyView.css?raw";
import { rememberMapTitle } from "../../../engine/ui/MapTitles";
import { GamePanel } from "../../../engine/ui/panels/GamePanel";
import { UIStyles } from "../../../engine/ui/UIStyles";
import { accountIsNew, currentIdentity, LoginError } from "../../../lobby/AccountSession";
import { CLIENT_DISCONNECT_REASON, type LobbyClient } from "../../../lobby/LobbyClient";
import type { DemoInfo, GametypeInfo, LiveMatchInfo, MatchLobbyInfo, PlayerInfo } from "../../../lobby/types";
import { ChatScroll } from "./ChatScroll";
import { CreditsDialog } from "./credits/CreditsDialog";
import { DemoService } from "./DemoService";
import { type DemoScope, DemosView } from "./DemosView";
import { devLog } from "./DevLog";
import { ensureFpsLobbyConnection, getFpsLobbyClient } from "./FpsLobbyService";
import { LeaderboardView } from "./LeaderboardView";
import { LobbyFullNotice, offlineRetryDelaySec } from "./LobbyFullNotice";
import { describeRoom, playKeys, roomCountLabel, sortRooms } from "./LobbyRooms";
import { LobbyWelcomeGuide } from "./LobbyWelcomeGuide";
import { bindFeaturedDemos, bindLeaderboard, bindPlayerStats, newUiApi } from "./NewUiApi";
import { ProfileView } from "./ProfileView";
import { buildRailBrand } from "./RailBrand";
import { nameColor, RoomChatView } from "./RoomChatView";
import { FPSSettingsView } from "./settings/FPSSettingsView";
import creditsCSSRaw from "./styles/CreditsDialog.css?raw";
import lobbyCSSRaw from "./styles/LobbyPanel.css?raw";
import { WelcomeOverlay } from "./WelcomeOverlay";

// ═══════════════════════════════════════════════════════════════════
// TYPES & DATA
// ═══════════════════════════════════════════════════════════════════

interface GameMode {
  id: string;
  title: string;
  subtitle: string;
  hook: string;
  specs: string[];
  /** Face, highlight, shade, and the two side tones of the mode's keys. */
  accent: [string, string, string, string, string];
  /** The mode's mark in the rail's room list, dark enough to read on cream. */
  mark: string;
}

const GAME_MODES: GameMode[] = [
  {
    id: "duel",
    title: "Duel",
    subtitle: "1 vs 1",
    hook: "Timing, aim, and nerve. Nothing extra.",
    specs: ["One on one", "Control pace", "Item timing", "Rail · Rocket · Blade"],
    accent: ["hsl(182 95% 52%)", "hsl(182 100% 74%)", "hsl(188 90% 40%)", "hsl(192 85% 28%)", "hsl(198 80% 17%)"],
    mark: "hsl(186 95% 42%)",
  },
  {
    id: "amphi",
    title: "Amphi",
    subtitle: "Aim arena",
    hook: "Tiny arena, short rounds. Pick a kit, prove your aim.",
    specs: ["One on one", "3 min rounds", "First to three", "Pick your loadout"],
    accent: ["hsl(100 85% 52%)", "hsl(98 95% 72%)", "hsl(108 80% 40%)", "hsl(115 70% 26%)", "hsl(125 65% 16%)"],
    mark: "hsl(104 80% 38%)",
  },
  {
    id: "ffa",
    title: "FFA",
    subtitle: "Free for all",
    hook: "Spawn hot, scrap hard, steal the lead.",
    specs: ["Open pit", "Fast chaos", "Fast respawn", "GL · Rocket · Blade"],
    accent: ["hsl(46 100% 57%)", "hsl(51 100% 73%)", "hsl(41 100% 48%)", "hsl(34 90% 36%)", "hsl(28 85% 23%)"],
    mark: "hsl(38 100% 44%)",
  },
  {
    id: "snd",
    title: "S&D",
    subtitle: "Search & destroy",
    hook: "Plant it, or make sure they never do.",
    specs: ["5 vs 5 rounds", "One life", "Two sites", "Rocket · Bomb · Armor"],
    accent: ["hsl(322 95% 62%)", "hsl(322 100% 77%)", "hsl(318 85% 50%)", "hsl(312 70% 33%)", "hsl(306 70% 21%)"],
    mark: "hsl(322 90% 52%)",
  },
];

/** Messages kept in the chat log; older ones scroll away for good. */
const CHAT_LOG_LIMIT = 100;
/** How long a spectator's Join waits on the lobby for a seat. */
const DROP_IN_ANSWER_MS = 8000;

const ACCENT_PROPERTIES = ["--accent", "--accent-hi", "--accent-lo", "--accent-side-hi", "--accent-side-lo"];
/** The team's devlog, opened from the Play page's links bar in a new tab. */
const DEVLOG_URL = "https://washoi.net/devlog";

/** Give `element` a mode's accent, for the keys and light inside it. */
function applyAccent(element: HTMLElement, mode: GameMode): void {
  ACCENT_PROPERTIES.forEach((property, index) => {
    element.style.setProperty(property, mode.accent[index]);
  });
}

function clockTime(ts: number): string {
  const time = new Date(ts);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

export class LobbyPanel extends GamePanel {
  private modesContainer: HTMLElement | null = null;
  private playBodyEl: HTMLElement | null = null;
  private matchLobbyView: MatchLobbyView | null = null;
  private roomChatView: RoomChatView | null = null;
  private settingsView: FPSSettingsView | null = null;
  private profileView: ProfileView | null = null;
  private profileKey: HTMLButtonElement | null = null;
  private welcomeOverlay: WelcomeOverlay | null = null;
  private welcomeGuide: LobbyWelcomeGuide | null = null;
  private creditsKey: HTMLButtonElement | null = null;
  private versionTag: HTMLSpanElement | null = null;
  private devlogLink: HTMLAnchorElement | null = null;
  private credits: CreditsDialog | null = null;
  private linksObserver: ResizeObserver | null = null;
  /** Up while the lobby has turned this player away at its player cap. */
  private lobbyFullNotice: LobbyFullNotice | null = null;
  private loginAttempt: Promise<void> | null = null;
  private loginFailures = 0;
  private destroyed = false;
  private currentInviteToken: string | undefined;
  private roomToRejoin: { lobbyId: string; inviteToken?: string; accountId: string } | null = null;

  // Lobby server connection
  private lobbyClient: LobbyClient;
  private livePlayers: PlayerInfo[] = [];
  private serverGametypes: GametypeInfo[] = [];
  private playerCountBadge: HTMLElement | null = null;
  private chatMessagesEl: HTMLElement | null = null;
  private chatScroll: ChatScroll | null = null;
  private chatColumnEl: HTMLElement | null = null;
  private chatInputEl: HTMLInputElement | null = null;
  private chatSendEl: HTMLButtonElement | null = null;
  private railEl: HTMLElement | null = null;
  /** A page's own list for the rail's middle, by tab. */
  private readonly railMids = new Map<string, HTMLElement>();
  private playerNameEl: HTMLElement | null = null;
  private playerMetaEl: HTMLElement | null = null;
  private selectedModeId = "duel";
  private currentTabId = "matchmaking";
  private queuePending = false;
  private playNoticeEl: HTMLElement | null = null;
  private findButton: HTMLButtonElement | null = null;
  private privateButton: HTMLButtonElement | null = null;
  private privateLobbySupported = false;
  private leaderboardView: LeaderboardView | null = null;
  private pendingPrivateCreate = false;

  private currentLobbyId: string | null = null;
  /** Lobby-server identity from Welcome; lobby roster order is not identity. */
  private localLobbyPlayerId: string | null = null;
  /** One-shot guard: the URL deep-link join runs on the first welcome only. */
  private urlLobbyJoinAttempted = false;
  private unsubscribers: (() => void)[] = [];

  // Live matches
  private liveMatches: LiveMatchInfo[] = [];
  private matchListEl: HTMLElement | null = null;
  private matchCountBadge: HTMLElement | null = null;

  private demosView: DemosView | null = null;
  private _preloadedLevelshots = new Set<string>();

  /**
   * Settles once the lobby has answered or failed to: logged in, with a new
   * player's name screen already up, or showing the disconnected state.
   */
  readonly connected: Promise<void>;

  constructor() {
    super("PLAY");
    this.closable = false;
    // The lobby's key variants override the base key, so the base goes in first
    injectRaisedKeyStyles();
    UIStyles.injectCSS("lobby-panel", lobbyCSSRaw);
    UIStyles.injectCSS("match-lobby", matchLobbyCSSRaw);

    this.lobbyClient = getFpsLobbyClient();
    bindLeaderboard(this.lobbyClient, false);
    bindPlayerStats(this.lobbyClient, false);
    bindFeaturedDemos(this.lobbyClient, false);
    this.addTab("matchmaking", "Play", this.buildMatchmakingTab());
    this.addTab("leaderboard", "Leaderboard", this.buildLeaderboardTab());
    this.addTab("demos", "Demos", this.buildDemosTab());
    this.addTab("settings", "Settings", this.buildSettingsTab());
    this.useRailLayout(this.buildRail());
    this.switchTab("matchmaking");
    this.onTabChange((tabId) => {
      this.currentTabId = tabId;
      for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-tab-id]")) {
        if (button.dataset.tabId === tabId) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
      // A page that is not on screen has no scroll position, so the chat has to
      // be sent back to its newest message when the Play page returns.
      if (tabId === "matchmaking") this.chatScroll?.toBottom();
      this.showRailMiddle(tabId);
      if (tabId === "settings") void this.settingsView?.refresh();
      if (tabId === "demos") this.demosView?.show();
      else this.demosView?.deactivate();
      if (tabId === "leaderboard") void this.leaderboardView?.refresh();
      if (tabId !== "settings" && this.welcomeGuide?.suspended) this.welcomeGuide.resume();
      this.welcomeGuide?.refresh();
      this.syncCredits();
    });
    this.tabBar.querySelector('[data-tab-id="matchmaking"]')?.setAttribute("aria-current", "page");
    const links = document.createElement("nav");
    links.className = "lobby__links";
    links.setAttribute("aria-label", "Lobby links");
    this.centerZone.append(links);
    this.linksObserver = new ResizeObserver(() => {
      const height = `${links.getBoundingClientRect().height}px`;
      this.centerZone.style.setProperty("--lobby-links-height", height);
      // The offline notice is fixed to the panel's corner and sits above the links.
      this.root.style.setProperty("--lobby-links-height", height);
    });
    this.linksObserver.observe(links);
    this.welcomeGuide = new LobbyWelcomeGuide({
      root: this.root,
      helpParent: links,
      showHelp: () => this.currentTabId === "matchmaking" && !this.matchLobbyView,
      canOpen: () => !this.welcomeOverlay && !this.profileView?.isOpen && !this.lobbyFullNotice?.isFull,
      prepareOpen: () => this.settingsView?.pauseControls(),
      openControls: (back) => {
        this.switchTab("settings");
        this.settingsView?.showPage("controls");
        this.settingsView?.getElement().prepend(back);
        back.focus();
      },
      finished: () => this.runDeepLinkJoin(),
    });
    this.creditsKey = this.buildCreditsKey();
    // The version beside Credits, so a screenshot for a bug report carries it.
    this.versionTag = document.createElement("span");
    this.versionTag.className = "lobby-version";
    this.versionTag.textContent = EngineVersion.getInstance().getVersionString();
    this.devlogLink = document.createElement("a");
    this.devlogLink.className = "lobby-credits-key";
    this.devlogLink.href = DEVLOG_URL;
    this.devlogLink.target = "_blank";
    this.devlogLink.rel = "noopener noreferrer";
    this.devlogLink.textContent = "DEVLOG";
    this.devlogLink.title = "News from the team, in a new tab";
    links.prepend(this.versionTag, this.devlogLink, this.creditsKey);
    this.connected = this.initLobbyConnection();
  }

  /** Credits sit beside the welcome guide's ? on the Play page, online or not. */
  private buildCreditsKey(): HTMLButtonElement {
    UIStyles.injectCSS("lobby-credits", creditsCSSRaw);
    const key = document.createElement("button");
    key.type = "button";
    key.className = "lobby-credits-key";
    key.textContent = "CREDITS";
    key.title = "Credits & copyrights";
    key.setAttribute("aria-haspopup", "dialog");
    key.addEventListener("click", () => {
      if (this.credits) return;
      this.credits = new CreditsDialog({ background: this.root, onClose: () => this.closeCredits() });
    });
    return key;
  }

  private syncCredits(): void {
    if (!this.creditsKey) return;
    this.creditsKey.hidden = this.currentTabId !== "matchmaking" || this.matchLobbyView !== null;
    if (this.versionTag) this.versionTag.hidden = this.creditsKey.hidden;
    if (this.devlogLink) this.devlogLink.hidden = this.creditsKey.hidden;
    if (this.creditsKey.hidden) this.closeCredits(false);
  }

  private closeCredits(restoreFocus = true): void {
    this.credits?.destroy(restoreFocus);
    this.credits = null;
  }

  private buildRail(): HTMLElement {
    const rail = document.createElement("aside");
    rail.className = "lobby__rail";
    rail.setAttribute("aria-label", "Main menu");
    this.railEl = rail;

    rail.appendChild(buildRailBrand("lobby__rail-brand"));

    const nav = document.createElement("nav");
    nav.className = "lobby__rail-nav";
    nav.setAttribute("aria-label", "Pages");
    this.tabBar.className = "lobby__rail-keys";
    for (const [id, hint] of [
      ["matchmaking", "4 modes"],
      ["leaderboard", "Top players"],
      ["demos", "Replays"],
    ]) {
      const button = this.tabButton(id);
      if (button) raiseKey(button, { label: button.textContent ?? "", hint, variants: ["nav"] });
    }
    nav.appendChild(this.tabBar);
    rail.appendChild(nav);
    rail.appendChild(this.buildSocialColumn());
    rail.appendChild(this.buildSettingsRail());
    for (const [tabId, middle] of [
      ["leaderboard", this.leaderboardView?.railMiddle],
      ["demos", this.demosView?.railMiddle],
    ] as const) {
      if (!middle) continue;
      middle.hidden = true;
      this.railMids.set(tabId, middle);
      rail.appendChild(middle);
    }

    const player = document.createElement("div");
    player.className = "lobby__rail-player";
    const avatar = document.createElement("span");
    avatar.className = "lobby__rail-avatar";
    avatar.setAttribute("aria-hidden", "true");
    const who = document.createElement("div");
    who.className = "lobby__rail-who";
    this.playerNameEl = document.createElement("strong");
    this.playerMetaEl = document.createElement("span");
    who.append(this.playerNameEl, this.playerMetaEl);
    player.append(avatar, who);
    rail.appendChild(player);

    const utility = document.createElement("div");
    utility.className = "lobby__rail-utility";
    // Profile is not a page: the rail widens into the gold panel and holds it
    this.profileKey = createRaisedKey({ label: "Profile", variants: ["sm", "util"] });
    this.profileKey.setAttribute("aria-haspopup", "dialog");
    this.profileKey.addEventListener("click", () => this.openProfile());
    utility.appendChild(this.profileKey);
    const settingsKey = this.tabButton("settings");
    if (settingsKey) utility.appendChild(raiseKey(settingsKey, { label: "Settings", variants: ["sm", "util"] }));
    const consoleButton = createRaisedKey({ label: "Console", variants: ["sm", "util"] });
    consoleButton.addEventListener("click", () => DebugConsole.getInstance().toggle());
    utility.appendChild(consoleButton);
    rail.appendChild(utility);
    this.refreshPlayerCard();
    return rail;
  }

  /** The settings pages, in the rail's middle while Settings is open. */
  private buildSettingsRail(): HTMLElement {
    const mid = document.createElement("section");
    mid.className = "lobby__rail-mid";
    mid.setAttribute("aria-label", "Settings pages");
    const heading = document.createElement("div");
    heading.className = "lobby__rail-label";
    heading.textContent = "Settings";
    mid.appendChild(heading);
    if (this.settingsView) mid.appendChild(this.settingsView.takePageNav());
    this.railMids.set("settings", mid);
    mid.hidden = true;
    return mid;
  }

  /** The rail's middle belongs to the page: its own list if it has one, else the rooms. */
  private showRailMiddle(tabId: string): void {
    const own = this.railMids.get(tabId);
    for (const mid of this.railMids.values()) mid.hidden = mid !== own;
    const rooms = this.railEl?.querySelector<HTMLElement>(".lobby__rail-mid--rooms");
    if (rooms) rooms.hidden = own !== undefined;
  }

  private tabButton(id: string): HTMLButtonElement | null {
    // The rail is built before it joins the panel, so look in the tab bar first
    const selector = `[data-tab-id="${id}"]`;
    return this.tabBar.querySelector<HTMLButtonElement>(selector) ?? this.root.querySelector(selector);
  }

  /**
   * The rail's player card: the account's name, and where the player is.
   * `name` is for lobby messages this panel hears before AccountSession does.
   */
  private refreshPlayerCard(name?: string): void {
    if (this.playerNameEl) {
      this.playerNameEl.textContent = name ?? currentIdentity()?.name ?? PlayerProfile.load().name;
    }
    if (this.playerMetaEl) {
      this.playerMetaEl.textContent = !this.lobbyClient.connected
        ? this.lobbyFullNotice?.isFull
          ? "Servers full"
          : "Offline"
        : this.currentLobbyId
          ? "In a room"
          : "In lobby";
    }
    const playKey = this.tabButton("matchmaking");
    if (playKey) setRaisedKeyText(playKey, "Play", this.currentLobbyId ? "In a room" : "4 modes");
  }

  // Lobby Server Connection
  private async initLobbyConnection(): Promise<void> {
    try {
      // Handle welcome — initial data dump
      this.unsubscribers.push(
        this.lobbyClient.on("welcome", (msg) => {
          this.loginFailures = 0;
          this.lobbyFullNotice?.close();
          devLog("[LobbyPanel] Welcome from lobby server:", msg.playerId);
          this.localLobbyPlayerId = msg.playerId;
          this.refreshPlayerCard(msg.identity?.name);
          this.serverGametypes = msg.gametypes || [];
          this.privateLobbySupported = msg.features?.privateLobbies === true;
          bindLeaderboard(this.lobbyClient, msg.features?.leaderboard === true, msg.features?.skillRatings === true);
          bindPlayerStats(this.lobbyClient, msg.features?.playerStats === true);
          bindFeaturedDemos(this.lobbyClient, msg.features?.featuredDemos === true);
          this.demosView?.connected(msg.features?.demoOwnership === true, this.currentTabId === "demos");
          if (this.currentTabId === "leaderboard") void this.leaderboardView?.refresh();
          this.queuePending = false;
          if (this.playNoticeEl) this.playNoticeEl.textContent = "";
          this.refreshModeAvailability();
          this.livePlayers = msg.onlinePlayers || [];
          this.refreshPlayerList();

          // Load live rooms, then render once
          this.liveMatches = msg.liveMatches || [];
          this.refreshMatchList();

          // Preload levelshots for all maps in gametype pools
          const poolMaps = new Set<string>();
          for (const gt of msg.gametypes || []) {
            for (const m of gt.mapPool || []) poolMaps.add(m);
          }
          this._preloadLevelshots([...poolMaps]);

          // Chat history, in place of whatever an earlier connection left in the log
          this.chatMessagesEl?.replaceChildren();
          for (const c of msg.chatHistory || []) {
            this.appendChatMessage(c.from, c.text, false, c.ts);
          }
          this.showChatEmpty();
          this.chatScroll?.toBottom();
          this.restoreRoom(msg.identity?.id);
        }),
      );

      // Player join/leave/status
      this.unsubscribers.push(
        this.lobbyClient.on("player:join", (msg) => {
          this.livePlayers.push(msg.player);
          this.refreshPlayerList();
        }),
      );
      this.unsubscribers.push(
        this.lobbyClient.on("player:leave", (msg) => {
          this.livePlayers = this.livePlayers.filter((p) => p.id !== msg.playerId);
          this.refreshPlayerList();
        }),
      );
      this.unsubscribers.push(
        this.lobbyClient.on("player:status", (msg) => {
          const player = this.livePlayers.find((p) => p.id === msg.playerId);
          if (player) player.status = msg.status;
          this.refreshPlayerList();
        }),
      );
      this.unsubscribers.push(
        this.lobbyClient.on("player:renamed", (msg) => {
          const player = this.livePlayers.find((p) => p.id === msg.playerId);
          if (player) player.name = msg.name;
        }),
      );
      // This account's new name, from this tab or another one logged in to it
      this.unsubscribers.push(
        this.lobbyClient.on("identity:renamed", (msg) => this.refreshPlayerCard(msg.identity.name)),
      );

      // Chat messages
      this.unsubscribers.push(
        this.lobbyClient.on("chat:message", (msg) => {
          this.appendChatMessage(msg.from, msg.text, false, msg.ts);
        }),
      );

      // Lobby created (response to lobby:create)
      this.unsubscribers.push(
        this.lobbyClient.on("lobby:created", (msg) => {
          this.handleLobbyCreated(msg.lobby);
        }),
      );

      this.unsubscribers.push(
        this.lobbyClient.on("lobby:kicked", (msg) => {
          if (msg.lobbyId !== this.currentLobbyId) return;
          this.showPlayStage();
          this.appendChatMessage("", `Left room: ${msg.reason}`, true);
        }),
      );

      // Lobby errors
      this.unsubscribers.push(
        this.lobbyClient.on("lobby:error", (msg) => {
          console.warn("[LobbyPanel] Lobby error:", msg.error);
          this.queuePending = false;
          this.pendingPrivateCreate = false;
          if (this.playNoticeEl) this.playNoticeEl.textContent = msg.error;
          this.refreshModeAvailability();
        }),
      );

      // Live matches updates
      this.unsubscribers.push(
        this.lobbyClient.on("matches:update", (msg) => {
          const before = new Map(this.liveMatches.map((match) => [match.id, match.state]));
          this.liveMatches = msg.matches || [];
          for (const match of this.liveMatches) {
            if (match.state === "playing" && before.get(match.id) === "waiting") this.announceMatch(match);
          }
          this.refreshMatchList();
        }),
      );

      this.unsubscribers.push(
        this.lobbyClient.on("_disconnected", (msg: { reason?: string }) => {
          this.welcomeGuide?.setAuthenticated(false);
          const identity = currentIdentity();
          if (this.currentLobbyId && identity) {
            this.roomToRejoin = {
              lobbyId: this.currentLobbyId,
              inviteToken: this.currentInviteToken,
              accountId: identity.id,
            };
          }
          this.queuePending = false;
          this.pendingPrivateCreate = false;
          this.privateLobbySupported = false;
          bindLeaderboard(this.lobbyClient, false);
          bindPlayerStats(this.lobbyClient, false);
          bindFeaturedDemos(this.lobbyClient, false);
          this.leaderboardView?.clear();
          this.demosView?.disconnected();
          if (this.playNoticeEl) this.playNoticeEl.textContent = "";
          this.serverGametypes = [];
          this.liveMatches = [];
          this.livePlayers = [];
          this.refreshModeAvailability();
          this.refreshMatchList();
          this.refreshPlayerList();
          if (this.matchLobbyView) this.showPlayStage();
          this.refreshPlayerCard();
          this.showChatEmpty();
          // Capacity refusals close the socket after auth:error; keep their
          // longer wait instead of replacing it with the outage backoff. A
          // close this client made itself (switching accounts) reconnects on
          // its own, so a retry here would only race it.
          const deliberate = msg?.reason === CLIENT_DISCONNECT_REASON;
          if (!this.destroyed && !this.loginAttempt && !this.lobbyFullNotice?.isFull && !deliberate) {
            this.scheduleOfflineRetry();
          }
        }),
      );

      // Match ended — the game server exited. In the single-match flow the
      // lobby IS the rematch screen: LobbyServer.handleServerExit resets it to
      // "waiting" and keeps everyone in it (docs/research/single_game_server_lobby.md).
      // So STAY in the match lobby view. Kicking to the gametype cards here
      // raced the ?lobby= deep-link return — a player who reloaded back into the
      // lobby got bounced to the cards 1-2s later when the old server's exit
      // broadcast arrived. (Manual "leave" still returns to the cards.)
      this.unsubscribers.push(
        this.lobbyClient.on("match:ended", (msg) => {
          this.demosView?.matchEnded();
          devLog(`[LobbyPanel] Match ended (${msg.matchId}) — staying in rematch lobby`);
          this.appendChatMessage("", "⚔ Match ended — ready up to rematch", true);
        }),
      );

      // Demo archive list response
      this.unsubscribers.push(
        this.lobbyClient.on("demos:list_response", (msg) => {
          this.demosView?.receiveList(
            (msg.scope ?? "latest") as DemoScope,
            (msg.demos || []) as DemoInfo[],
            msg.requestId,
          );
        }),
      );
    } catch (err) {
      console.warn("[LobbyPanel] Could not set up the lobby connection:", err);
    }
    await this.logInToLobby();
  }

  /**
   * Connect and log in. Settles either way: logged in, waiting out a full
   * lobby, or showing the disconnected state.
   */
  private logInToLobby(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.loginAttempt) return this.loginAttempt;
    const pending = this.performLobbyLogin().finally(() => {
      if (this.loginAttempt === pending) this.loginAttempt = null;
    });
    this.loginAttempt = pending;
    return pending;
  }

  private scheduleOfflineRetry(): void {
    if (this.destroyed) return;
    this.lobbyFullNotice ??= new LobbyFullNotice(() => void this.logInToLobby());
    this.lobbyFullNotice.waitOffline(this.root, offlineRetryDelaySec(++this.loginFailures));
    this.refreshPlayerCard();
  }

  private restoreRoom(accountId: string | undefined): void {
    const room = this.roomToRejoin;
    this.roomToRejoin = null;
    if (room && room.accountId === accountId) this.lobbyClient.joinLobby(room.lobbyId, room.inviteToken);
  }

  private async performLobbyLogin(): Promise<void> {
    try {
      await ensureFpsLobbyConnection();
    } catch (err) {
      if (this.destroyed) return;
      this.welcomeGuide?.setAuthenticated(false);
      if (err instanceof LoginError && err.code === "lobby_full") {
        devLog("[LobbyPanel] Lobby is full; waiting to try again");
        this.lobbyFullNotice ??= new LobbyFullNotice(() => void this.logInToLobby());
        this.lobbyFullNotice.wait(this.root, err.retryAfterSec);
        this.showDisconnectedState(false);
        return;
      }
      console.warn("[LobbyPanel] Could not connect to lobby server:", err);
      devLog("[LobbyPanel] Showing disconnected lobby state");
      this.scheduleOfflineRetry();
      this.showDisconnectedState(false);
      return;
    }
    if (this.destroyed) return;
    this.loginFailures = 0;
    this.lobbyFullNotice?.close();

    // Share lobby client with DemoService so console `demolist` command works
    DemoService.getInstance().setLobbyClient(this.lobbyClient);

    // A browser the lobby has just made an account for is asked who it is,
    // and joins a shared room link only once it has answered
    if (accountIsNew()) this.showWelcome();
    this.welcomeGuide?.setAuthenticated(true);
    if (!accountIsNew()) this.runDeepLinkJoin();
  }

  /**
   * Ask a new player for a name, over the lobby. The account already exists —
   * the answer renames it, and "Use my key" swaps it for an account they have.
   */
  private showWelcome(): void {
    if (this.welcomeOverlay) return;
    this.welcomeOverlay = new WelcomeOverlay(() => {
      if (this.destroyed) return;
      this.welcomeOverlay = null;
      this.refreshPlayerCard();
      this.welcomeGuide?.setAuthenticated(true);
      this.runDeepLinkJoin();
    });
    this.welcomeOverlay.open(this.root);
  }

  /** Drop `?invite=` from the address bar, once the room it opens is open. */
  private forgetInviteInUrl(lobbyId: string): void {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("invite")) return;
      const shown = url.searchParams.get("lobby") ?? url.pathname.match(/\/lobby\/([A-Za-z0-9_-]+)/)?.[1];
      if (shown !== lobbyId) return;
      url.searchParams.delete("invite");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // An address bar this browser will not rewrite is not worth failing a join over.
    }
  }

  /**
   * Deep link: /lobby/<id> or ?lobby=<id> — join once per page load. Covers
   * shared lobby links AND the post-game RETURN TO LOBBY navigation
   * (docs/research/single_game_server_lobby.md). The server replies with
   * lobby:created (full state dump), which opens the room view through the
   * normal handler.
   */
  private runDeepLinkJoin(): void {
    if (this.destroyed) return;
    if (this.welcomeGuide && !this.welcomeGuide.readyForJoin) return;
    if (this.urlLobbyJoinAttempted || !this.lobbyClient.connected) return;
    this.urlLobbyJoinAttempted = true;
    const url = new URL(window.location.href);
    const pathMatch = url.pathname.match(/\/lobby\/([A-Za-z0-9_-]+)/);
    const deepLinkLobby = url.searchParams.get("lobby") || pathMatch?.[1];
    if (deepLinkLobby) {
      devLog(`[LobbyPanel] Deep link → joining lobby ${deepLinkLobby}`);
      let inviteToken = url.searchParams.get("invite") || undefined;
      if (!inviteToken) {
        try {
          inviteToken = sessionStorage.getItem(`shag.private_invite.${deepLinkLobby}`) || undefined;
        } catch {
          // An ordinary public room does not require local storage.
        }
      }
      this.lobbyClient.joinLobby(deepLinkLobby, inviteToken);
    }
  }

  /** Clear the lobby's data; `announce` says so in the chat. */
  private showDisconnectedState(announce = true): void {
    this.queuePending = false;
    this.pendingPrivateCreate = false;
    this.privateLobbySupported = false;
    bindFeaturedDemos(this.lobbyClient, false);
    this.leaderboardView?.clear();
    this.demosView?.disconnected();
    if (this.playNoticeEl) this.playNoticeEl.textContent = "";
    this.livePlayers = [];
    this.liveMatches = [];
    this.refreshPlayerList();
    this.refreshMatchList();
    this.refreshModeAvailability();
    this.refreshPlayerCard();
    this.showChatEmpty();
    if (announce) this.appendChatMessage("", "Lobby server unavailable. Reconnect to chat or find a match.", true);
  }

  private refreshPlayerList(): void {
    if (this.playerCountBadge) {
      this.playerCountBadge.textContent = this.lobbyClient.connected ? `${this.livePlayers.length} online` : "Offline";
    }
  }

  /** "Duel on Proving Grounds started · Reaper vs Eclipse": public rooms only, as the list is. */
  private announceMatch(match: LiveMatchInfo): void {
    const mode = GAME_MODES.find((item) => item.id === match.gametype)?.title ?? match.gametypeName ?? match.gametype;
    const where = match.mapDisplayName || match.map;
    const who =
      match.players.length === 2 ? match.players.join(" vs ") : `${match.players.length || match.playerCount} players`;
    this.appendChatMessage("", `${mode}${where ? ` on ${where}` : ""} started · ${who}`, true);
  }

  /** An empty log says what it is for, rather than sitting blank. */
  private showChatEmpty(): void {
    const log = this.chatMessagesEl;
    if (!log) return;
    const existing = log.querySelector<HTMLParagraphElement>(".lobby-chat__empty");
    if (!existing && log.childElementCount > 0) return;
    const empty = existing ?? document.createElement("p");
    empty.className = "lobby-chat__empty";
    empty.textContent = this.lobbyClient.connected
      ? "Nobody has said anything yet. Say hello."
      : "Chat opens when the lobby server is back.";
    log.appendChild(empty);
  }

  private appendChatMessage(from: string, text: string, system: boolean, ts = Date.now()): void {
    const log = this.chatMessagesEl;
    if (!log) return;
    log.querySelector(".lobby-chat__empty")?.remove();
    const span = (className: string, content: string) => {
      const el = document.createElement("span");
      el.className = className;
      el.textContent = content;
      return el;
    };

    const msg = document.createElement("div");
    msg.className = "lobby-chat__msg";
    const time = span("lobby-chat__time", clockTime(ts));
    if (system || !from) {
      msg.classList.add("lobby-chat__msg--sys");
      msg.append(time, span("lobby-chat__text", text));
    } else {
      // Names are unique to an account, so a message under this account's name is ours
      const mine = from === (currentIdentity()?.name ?? PlayerProfile.load().name);
      const who = span("lobby-chat__who", from);
      if (mine) msg.classList.add("lobby-chat__msg--me");
      else who.style.setProperty("--who", nameColor(from));
      msg.append(time, who, span("lobby-chat__text", text));
    }

    log.appendChild(msg);
    while (log.childElementCount > CHAT_LOG_LIMIT) log.firstElementChild?.remove();
    // Follows new messages only when already at the bottom, so reading back isn't interrupted
    this.chatScroll?.follow();
  }

  private handleLobbyCreated(lobby: MatchLobbyInfo): void {
    if (this.matchLobbyView) this.showPlayStage();
    let inviteToken: string | null = null;
    if (lobby.visibility === "private") {
      try {
        inviteToken = new URL(lobby.shareUrl, window.location.origin).searchParams.get("invite");
      } catch {
        // The server response is not a usable invite URL.
      }
    }
    if (this.pendingPrivateCreate && (lobby.visibility !== "private" || !inviteToken)) {
      this.pendingPrivateCreate = false;
      this.queuePending = false;
      this.lobbyClient.leaveLobby(lobby.id);
      if (this.playNoticeEl) this.playNoticeEl.textContent = "The server did not provide a private invite room.";
      this.refreshModeAvailability();
      return;
    }
    this.pendingPrivateCreate = false;
    this.queuePending = false;
    if (this.playNoticeEl) this.playNoticeEl.textContent = "";
    this.currentLobbyId = lobby.id;
    this.currentInviteToken = inviteToken ?? undefined;
    if (inviteToken) {
      let stashed = false;
      try {
        sessionStorage.setItem(`shag.private_invite.${lobby.id}`, inviteToken);
        stashed = true;
      } catch {
        // The current room still works; a return after navigation needs the invite link.
      }
      // An invite left in the address bar is in the history, in every
      // screenshot and on every stream — for a room only the invited should
      // reach. Take it out once it is stashed, which is where a reload and the
      // post-match return read it from anyway.
      if (stashed) this.forgetInviteInUrl(lobby.id);
    }
    if (!this.modesContainer || !this.playBodyEl) return;

    // Create match lobby view with real server data
    this.matchLobbyView = new MatchLobbyView(
      lobby.gametype,
      this.lobbyClient,
      lobby,
      this.localLobbyPlayerId ?? undefined,
    );
    this.matchLobbyView.onLeave(() => {
      if (this.currentLobbyId) {
        this.lobbyClient.leaveLobby(this.currentLobbyId);
        this.currentLobbyId = null;
        this.roomToRejoin = null;
        this.currentInviteToken = undefined;
      }
      this.showPlayStage();
    });

    // The stage keeps its light and backdrop word; the room takes its body,
    // and the whole stage takes the room's colour.
    const mode = GAME_MODES.find((item) => item.id === lobby.gametype);
    if (mode) {
      applyAccent(this.modesContainer, mode);
      const ghost = this.modesContainer.querySelector<HTMLElement>(".lobby__ghost");
      if (ghost) ghost.textContent = mode.title.toUpperCase();
    }
    this.playBodyEl.replaceWith(this.matchLobbyView.root);
    this.welcomeGuide?.refresh();
    this.syncCredits();
    // A room opens at its top, however far down the Play page was scrolled
    this.modesContainer.scrollTop = 0;
    const railMiddle = this.railEl?.querySelector(".lobby__rail-mid--rooms");
    if (railMiddle) {
      this.roomChatView = new RoomChatView(this.lobbyClient, lobby, this.localLobbyPlayerId);
      railMiddle.appendChild(this.roomChatView.root);
      this.railEl?.classList.add("lobby__rail--room");
    }
    this.refreshPlayerCard();
    devLog(`[LobbyPanel] Opened match lobby: ${lobby.id}`);
  }

  show(): void {
    this.open();
    // A name screen opened while the lobby was still hidden could not take focus
    this.welcomeOverlay?.focus();
    this.welcomeGuide?.show();
  }
  /** Initial boot handoff; ordinary lobby returns never call this. */
  initialLoadingDismissed(): void {
    this.welcomeGuide?.initialLoadingDismissed();
  }
  hide(): void {
    this.close();
  }

  public override close(): void {
    this.welcomeGuide?.leaveLobby();
    this.demosView?.deactivate();
    super.close();
  }

  isVisible(): boolean {
    return this.isOpen();
  }
  setOnPlay(_cb: (mode: string) => void): void {}
  onSettingsChange(_cb: (key: string, value: unknown) => void): void {}

  // ═══════════════════════════════════════════════════════════════════
  // TAB 1: MATCHMAKING
  // ═══════════════════════════════════════════════════════════════════

  private buildMatchmakingTab(): HTMLElement {
    const layout = document.createElement("div");
    layout.className = "lobby__layout";
    this.modesContainer = this.buildPlayStage();
    layout.appendChild(this.modesContainer);
    this.selectMode(GAME_MODES[0]);
    this.refreshModeAvailability();
    return layout;
  }

  private buildPlayStage(): HTMLElement {
    const stage = document.createElement("div");
    stage.className = "lobby__page lobby__play";
    stage.append(this.buildStageLight());
    const ghost = document.createElement("div");
    ghost.className = "lobby__ghost";
    ghost.setAttribute("aria-hidden", "true");
    stage.append(ghost);

    const body = document.createElement("div");
    body.className = "lobby__play-body";
    this.playBodyEl = body;
    stage.appendChild(body);

    const header = document.createElement("header");
    header.className = "lobby__heading";
    const kicker = document.createElement("span");
    kicker.className = "lobby__kicker";
    kicker.textContent = "Play";
    const title = document.createElement("h1");
    title.className = "lobby__title";
    title.textContent = "Pick your fight";
    header.append(kicker, title);
    body.appendChild(header);

    const tiles = document.createElement("div");
    tiles.className = "lobby__play-tiles";
    tiles.setAttribute("role", "group");
    tiles.setAttribute("aria-label", "Game modes");
    GAME_MODES.forEach((mode, index) => {
      const band = document.createElement("span");
      band.className = "lobby__mode-band";
      const number = document.createElement("span");
      number.className = "lobby__mode-number";
      number.textContent = String(index + 1).padStart(2, "0");
      const status = document.createElement("span");
      status.className = "lobby__mode-status";
      const top = document.createElement("span");
      top.className = "lobby__mode-top";
      top.append(number, status);
      const name = document.createElement("span");
      name.className = "lobby__mode-name";
      name.textContent = mode.title;
      const subtitle = document.createElement("span");
      subtitle.className = "lobby__mode-subtitle";
      subtitle.textContent = mode.subtitle;
      const main = document.createElement("span");
      main.className = "lobby__mode-main";
      main.append(name, subtitle);

      const key = createRaisedKey({ variants: ["mode"], content: [band, top, main] });
      key.dataset.mode = mode.id;
      key.setAttribute("aria-pressed", "false");
      applyAccent(key, mode);
      key.addEventListener("click", () => this.selectMode(mode));
      tiles.appendChild(key);
    });
    body.appendChild(tiles);

    const lower = document.createElement("div");
    lower.className = "lobby__play-lower";
    const detail = document.createElement("section");
    detail.className = "lobby__play-detail";
    detail.setAttribute("aria-label", "Selected mode");
    const tagline = document.createElement("p");
    tagline.className = "lobby__play-tagline";
    const specs = document.createElement("div");
    specs.className = "lobby__play-specs";

    const actions = document.createElement("div");
    actions.className = "lobby__play-actions";
    this.findButton = createRaisedKey({ label: "", variants: ["cta"] });
    this.findButton.addEventListener("click", () => this.showMatchLobby(this.selectedModeId));
    const privateButton = createRaisedKey({
      label: "🔒 Private lobby",
      hint: "Invite only or bot matches",
      variants: ["cream", "private"],
    });
    this.privateButton = privateButton;
    privateButton.addEventListener("click", () => this.showPrivateLobby(this.selectedModeId));
    privateButton.disabled = true;
    privateButton.title = "Connect to a lobby server with private rooms.";
    actions.append(this.findButton, privateButton);

    const notice = document.createElement("p");
    notice.className = "lobby__play-notice";
    notice.setAttribute("role", "status");
    this.playNoticeEl = notice;
    detail.append(tagline, specs, actions, notice);
    lower.append(detail, this.buildChatColumn());
    body.appendChild(lower);
    return stage;
  }

  /** Three soft lights drifting behind a stage; only their transforms animate. */
  private buildStageLight(): HTMLElement {
    const light = document.createElement("div");
    light.className = "lobby__light";
    light.setAttribute("aria-hidden", "true");
    for (const tone of ["violet", "deep", "accent"]) {
      const orb = document.createElement("div");
      orb.className = `lobby__orb lobby__orb--${tone}`;
      light.appendChild(orb);
    }
    return light;
  }

  private selectMode(mode: GameMode): void {
    this.selectedModeId = mode.id;
    const stage = this.modesContainer;
    if (!stage) return;
    // The stage takes the picked mode's colours, so the key, the light and the backdrop word follow it
    applyAccent(stage, mode);
    for (const key of stage.querySelectorAll<HTMLButtonElement>(".raised-key--mode")) {
      key.setAttribute("aria-pressed", String(key.dataset.mode === mode.id));
    }
    const ghost = stage.querySelector<HTMLElement>(".lobby__ghost");
    if (ghost) ghost.textContent = mode.title.toUpperCase();
    const tagline = stage.querySelector<HTMLElement>(".lobby__play-tagline");
    if (tagline) tagline.textContent = mode.hook;
    const specs = stage.querySelector<HTMLElement>(".lobby__play-specs");
    specs?.replaceChildren(
      ...mode.specs.map((value) => {
        const spec = document.createElement("span");
        spec.className = "lobby__spec";
        spec.textContent = value;
        return spec;
      }),
    );
    this.refreshFindButton();
  }

  private refreshFindButton(): void {
    const button = this.findButton;
    if (!button) return;
    const mode = GAME_MODES.find((item) => item.id === this.selectedModeId) ?? GAME_MODES[0];
    const keys = playKeys({
      modeTitle: mode.title,
      available: newUiApi.getMode(mode.id, this.serverGametypes).status === "ready",
      connected: this.lobbyClient.connected,
      queuePending: this.queuePending,
      privateLobbySupported: this.privateLobbySupported,
      lobbyFull: this.lobbyFullNotice?.isFull === true,
    });
    button.disabled = keys.find.disabled;
    setRaisedKeyText(button, keys.find.label);
    if (this.privateButton) {
      this.privateButton.disabled = keys.private.disabled;
      this.privateButton.title = keys.private.title;
    }
  }

  private refreshModeAvailability(): void {
    if (!this.modesContainer) return;
    const connected = this.lobbyClient.connected;
    if (this.chatInputEl) {
      this.chatInputEl.disabled = !connected;
      this.chatInputEl.placeholder = connected ? "Say something…" : "Lobby offline";
    }
    if (this.chatSendEl) this.chatSendEl.disabled = !connected;
    for (const key of this.modesContainer.querySelectorAll<HTMLElement>(".raised-key--mode")) {
      const available = newUiApi.getMode(key.dataset.mode || "", this.serverGametypes).status === "ready";
      const status = key.querySelector<HTMLElement>(".lobby__mode-status");
      // Only a mode this lobby doesn't run yet is marked; offline shows on the Find key
      if (status) status.textContent = connected && !available ? "Soon" : "";
    }
    this.refreshFindButton();
  }

  private buildSocialColumn(): HTMLElement {
    const mid = document.createElement("section");
    mid.className = "lobby__rail-mid lobby__rail-mid--rooms";
    mid.setAttribute("aria-label", "Rooms");
    const heading = document.createElement("div");
    heading.className = "lobby__rail-label";
    const label = document.createElement("span");
    label.textContent = "Rooms";
    const count = document.createElement("span");
    this.matchCountBadge = count;
    heading.append(label, count);
    mid.appendChild(heading);
    mid.appendChild(this.buildMatchList());
    this.refreshMatchList();
    return mid;
  }

  private buildMatchList(): HTMLElement {
    const list = document.createElement("div");
    list.className = "lobby__rail-lobbies";
    this.matchListEl = list;
    return list;
  }

  private refreshMatchList(): void {
    for (const match of this.liveMatches) rememberMapTitle(match.map, match.mapDisplayName);
    if (!this.matchListEl) return;
    const matches = sortRooms(this.liveMatches);
    if (this.matchCountBadge) this.matchCountBadge.textContent = roomCountLabel(matches);
    if (matches.length === 0) {
      const empty = document.createElement("p");
      empty.className = "lobby__rail-empty";
      empty.textContent = this.lobbyClient.connected
        ? "No rooms yet. Pick a mode to start one."
        : this.lobbyFullNotice?.isFull
          ? "Servers are full."
          : "Lobby server offline.";
      this.matchListEl.replaceChildren(empty);
      return;
    }

    this.matchListEl.replaceChildren(
      ...matches.map((match) => {
        const mode = GAME_MODES.find((item) => item.id === match.gametype);
        const { action, where, disabled } = describeRoom(match);

        const mark = document.createElement("span");
        mark.className = "lobby__room-mark";
        const name = document.createElement("span");
        name.className = "raised-key__label";
        name.textContent = mode?.title ?? match.gametypeName ?? match.gametype;
        const map = document.createElement("span");
        map.className = "lobby__room-map";
        map.textContent = where;
        map.hidden = match.state !== "playing";
        const count = document.createElement("span");
        count.className = "raised-key__hint lobby__room-count";
        count.textContent = `${match.playerCount} / ${match.maxPlayers}`;
        const badge = document.createElement("span");
        badge.className = `lobby__room-badge lobby__room-badge--${action}`;
        badge.textContent = action;

        const row = createRaisedKey({ variants: ["sm", "cream", "room"], content: [mark, name, map, count, badge] });
        row.classList.add(`lobby__room--${match.state}`);
        row.style.setProperty("--mode-mark", mode?.mark ?? "hsl(250 20% 40%)");
        row.disabled = disabled;
        row.setAttribute(
          "aria-label",
          `${action} ${name.textContent}, ${where}: ${match.playerCount} of ${match.maxPlayers} players`,
        );
        if (action === "join") row.addEventListener("click", () => this.lobbyClient.joinLobby(match.id));
        const serverUrl = match.serverUrl;
        if (action === "watch" && serverUrl) {
          // Join while watching asks this room for a seat, for when one frees up.
          row.addEventListener("click", () =>
            new ConnectingOverlay().show(serverUrl, true, undefined, undefined, () => this.requestDropIn(match.id)),
          );
        }
        return row;
      }),
    );
  }

  /**
   * Ask a running room for a seat, for a spectator pressing Join. Resolves
   * once the lobby sends it, after which the room view hands the ticket to the
   * game; rejects with the lobby's reason, such as a full match.
   */
  private requestDropIn(roomId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const stop = () => {
        offConnect();
        offError();
        clearTimeout(timer);
      };
      const offConnect = this.lobbyClient.on("lobby:connect", () => {
        stop();
        resolve();
      });
      const offError = this.lobbyClient.on("lobby:error", (msg) => {
        stop();
        reject(new Error(msg.error));
      });
      const timer = setTimeout(() => {
        stop();
        reject(new Error("The lobby did not answer."));
      }, DROP_IN_ANSWER_MS);
      this.lobbyClient.joinLobby(roomId);
    });
  }

  private buildChatColumn(): HTMLElement {
    const panel = document.createElement("section");
    panel.className = "lobby-chat";
    panel.setAttribute("aria-label", "Lobby chat");
    this.chatColumnEl = panel;

    const head = document.createElement("div");
    head.className = "lobby-chat__head";
    const title = document.createElement("span");
    title.className = "lobby-chat__title";
    title.textContent = "Lobby";
    const online = document.createElement("span");
    online.className = "lobby-chat__online";
    const dot = document.createElement("span");
    dot.className = "lobby-chat__dot";
    const count = document.createElement("span");
    this.playerCountBadge = count;
    online.append(dot, count);
    head.append(title, online);
    panel.appendChild(head);

    const log = document.createElement("div");
    log.className = "lobby-chat__log";
    log.setAttribute("role", "log");
    this.chatMessagesEl = log;
    this.chatScroll = new ChatScroll(log);
    panel.appendChild(log);
    this.showChatEmpty();

    const form = document.createElement("form");
    form.className = "lobby-chat__form";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "lobby-chat__input";
    input.placeholder = "Say something…";
    input.maxLength = 500;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Message the lobby");
    // Typing here must not reach the game's key bindings
    input.addEventListener("keydown", (e) => e.stopPropagation());
    this.chatInputEl = input;
    const send = createRaisedKey({ label: "Send", variants: ["sm", "inline", "send"] });
    send.type = "submit";
    this.chatSendEl = send;
    form.append(input, send);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !this.lobbyClient.connected) return;
      this.lobbyClient.chatSend(text);
      input.value = "";
    });
    panel.appendChild(form);
    this.refreshPlayerList();
    return panel;
  }

  // ═══════════════════════════════════════════════════════════════════
  // TAB: DEMOS
  // ═══════════════════════════════════════════════════════════════════

  private buildDemosTab(): HTMLElement {
    this.demosView = new DemosView({
      client: this.lobbyClient,
      modes: GAME_MODES,
      light: this.buildStageLight(),
      leave: () => this.hide(),
      show: () => {
        this.switchTab("demos");
        this.show();
      },
    });
    return this.demosView.root;
  }

  /** Best-effort preload of levelshot images for given map names */
  private _preloadLevelshots(maps: string[]): void {
    for (const map of maps) {
      if (this._preloadedLevelshots.has(map)) continue;
      this._preloadedLevelshots.add(map);
      const img = new Image();
      img.src = `/data/levelshots/${map}.jpg`;
      // No-op on success or error — purely warming the browser cache
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // TAB 2: LEADERBOARD
  // ═══════════════════════════════════════════════════════════════════

  private buildLeaderboardTab(): HTMLElement {
    this.leaderboardView = new LeaderboardView(GAME_MODES, this.buildStageLight());
    return this.leaderboardView.root;
  }

  // Profile: the account's name, its key, and the way into another account
  /** The account on the gold panel, widened out of the rail over whatever page is open. */
  private openProfile(): void {
    if (!this.profileView) {
      this.profileView = new ProfileView({
        client: this.lobbyClient,
        isInRoom: () => this.currentLobbyId !== null,
        modes: () => this.serverGametypes,
        onClose: () => {
          this.profileKey?.setAttribute("aria-expanded", "false");
          this.refreshPlayerCard();
          this.profileKey?.focus();
          this.welcomeGuide?.setAuthenticated(this.lobbyClient.connected);
        },
      });
    }
    if (this.profileView.isOpen) return;
    this.profileKey?.setAttribute("aria-expanded", "true");
    this.profileView.open(this.root);
    this.welcomeGuide?.refresh();
  }

  // Settings
  private buildSettingsTab(): HTMLElement {
    if (!this.settingsView) {
      this.settingsView = new FPSSettingsView();
      void this.settingsView.refresh();
    }

    // The settings view brings its own page heading
    return this.settingsView.getElement();
  }

  private showMatchLobby(gametypeId: string): void {
    if (!this.modesContainer) return;
    if (!this.lobbyClient.connected) return;
    const mode = newUiApi.getMode(gametypeId, this.serverGametypes);
    if (mode.status === "unavailable") {
      console.warn(`[LobbyPanel] ${mode.reason}`);
      return;
    }
    this.queuePending = true;
    if (this.playNoticeEl) this.playNoticeEl.textContent = "Requesting a room...";
    this.refreshModeAvailability();
    this.lobbyClient.joinQueue(gametypeId);
    // Server sends lobby:created, which opens the room view.
  }

  private showPrivateLobby(gametypeId: string): void {
    if (!this.lobbyClient.connected || !this.privateLobbySupported || this.queuePending) return;
    if (newUiApi.getMode(gametypeId, this.serverGametypes).status !== "ready") return;
    this.queuePending = true;
    this.pendingPrivateCreate = true;
    if (this.playNoticeEl) this.playNoticeEl.textContent = "Creating a private room...";
    this.refreshModeAvailability();
    this.lobbyClient.createLobby(gametypeId, "private");
  }

  private showPlayStage(): void {
    if (!this.matchLobbyView || !this.modesContainer || !this.playBodyEl) return;

    // Return to the Play stage.
    this.roomChatView?.destroy();
    this.roomChatView = null;
    this.matchLobbyView.root.replaceWith(this.playBodyEl);
    this.modesContainer.scrollTop = 0;
    this.matchLobbyView.destroy();
    const selected = GAME_MODES.find((mode) => mode.id === this.selectedModeId) ?? GAME_MODES[0];
    this.selectMode(selected);
    const lower = this.modesContainer.querySelector(".lobby__play-lower");
    if (lower && this.chatColumnEl) lower.appendChild(this.chatColumnEl);
    this.railEl?.classList.remove("lobby__rail--room");
    this.matchLobbyView = null;
    this.currentLobbyId = null;
    this.currentInviteToken = undefined;
    this.refreshPlayerCard();
    this.welcomeGuide?.refresh();
    this.syncCredits();

    devLog("[LobbyPanel] Returned to Play stage");
  }

  public override destroy(): void {
    this.linksObserver?.disconnect();
    this.destroyed = true;
    this.chatScroll?.destroy();
    this.welcomeGuide?.destroy();
    this.closeCredits(false);
    bindLeaderboard(this.lobbyClient, false);
    bindPlayerStats(this.lobbyClient, false);
    bindFeaturedDemos(this.lobbyClient, false);
    this.demosView?.destroy();
    this.leaderboardView?.destroy();
    this.roomChatView?.destroy();
    this.matchLobbyView?.destroy();
    this.settingsView?.destroy();
    this.profileView?.destroy();
    this.welcomeOverlay?.destroy();
    this.lobbyFullNotice?.close();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    super.destroy();
  }
}
