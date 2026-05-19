/**
 * LobbyPanel — Main Lobby UI (extends GamePanel)
 *
 * Tabs:
 *   MATCHMAKING: Mode cards (left) + Social (center) + Chat (right)
 *   LEADERBOARD: Fun stat table with rankings
 *   MY PROFILE:  Player name, stats, settings
 */

import { DemoService } from "./DemoService";
import { DemoViewer } from "./DemoViewer";
import { DurationPickerModal } from "./DurationPickerModal";
import { ensureFpsLobbyConnection, getFpsLobbyClient } from "./FpsLobbyService";
import { FPSSettingsView } from "./settings/FPSSettingsView";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import type { DemoInfo, LiveMatchInfo, MatchLobbyInfo, PlayerInfo } from "../../../lobby/types";
import { CameraSystem } from "../../../engine/camera/CameraSystem";
import { DebugConsole } from "../../../engine/debug/DebugConsole";
import { ConnectingOverlay } from "../../../engine/ui/components/ConnectingOverlay";
import { MatchLobbyView } from "../../../engine/ui/components/MatchLobbyView";
import matchLobbyCSSRaw from "../../../engine/ui/components/styles/MatchLobbyView.css?raw";
import { UIStyles } from "../../../engine/ui/UIStyles";
import { GamePanel } from "../../../engine/ui/panels/GamePanel";
import demoTabCSSRaw from "./styles/DemoTab.css?raw";
import lobbyCSSRaw from "./styles/LobbyPanel.css?raw";

// ═══════════════════════════════════════════════════════════════════
// TYPES & DATA
// ═══════════════════════════════════════════════════════════════════

interface GameMode {
  id: string;
  title: string;
  subtitle: string;
  hue: string;
  queued: number;
  image?: string;
}

const GAME_MODES: GameMode[] = [
  { id: "duel", title: "DUEL", subtitle: "1 vs 1", hue: "180", queued: 4, image: "/data/ui/card_duel_opt.png" },
  { id: "team", title: "TEAM", subtitle: "2 vs 2", hue: "320", queued: 1, image: "/data/ui/card_2v2_opt.png" },
  { id: "ffa", title: "FFA", subtitle: "FREE FOR ALL", hue: "45", queued: 0, image: "/data/ui/card_ffa_opt.png" },
];

const MOCK_PLAYERS = [
  { name: "zeroQL", status: "searching" as const, mode: "DUEL" },
  { name: "washoi_dev", status: "online" as const },
  { name: "rocketJump99", status: "ingame" as const },
  { name: "fragmaster", status: "searching" as const, mode: "FFA" },
  { name: "neon_ghost", status: "online" as const },
  { name: "plasma_rush", status: "ingame" as const },
  { name: "strafejmp", status: "online" as const },
  { name: "q3_veteran", status: "online" as const },
  { name: "cpma_wizard", status: "searching" as const, mode: "DUEL" },
  { name: "rail_queen", status: "ingame" as const },
  { name: "shaft_master", status: "online" as const },
  { name: "bunny_hop", status: "online" as const },
  { name: "lg_demon", status: "ingame" as const },
  { name: "warsow_fan", status: "searching" as const, mode: "TEAM" },
  { name: "arena_noob", status: "online" as const },
  { name: "rocket_queen", status: "online" as const },
];

const MOCK_CHAT = [
  { name: "zeroQL", msg: "anyone up for a duel?" },
  { name: "washoi_dev", msg: "gg last game, that rocket was insane" },
  { name: "fragmaster", msg: "queueing FFA, join up!" },
  { name: "", msg: "plasma_rush joined the lobby", system: true },
  { name: "neon_ghost", msg: "new map when?" },
  { name: "q3_veteran", msg: "this engine is sick" },
  { name: "", msg: "rocketJump99 started a match", system: true },
  { name: "washoi_dev", msg: "nice movement tech in this build" },
  { name: "strafejmp", msg: "that crouchslide is smooth now" },
];

// ── Leaderboard mock data ──
const MOCK_LEADERBOARD = [
  {
    rank: 1,
    name: "zeroQL",
    rating: 2847,
    wins: 342,
    losses: 51,
    kd: "3.21",
    weapon: "Railgun",
    acc: "48%",
    topSpeed: "1240 ups",
    streak: 14,
  },
  {
    rank: 2,
    name: "cpma_wizard",
    rating: 2691,
    wins: 289,
    losses: 67,
    kd: "2.85",
    weapon: "Lightning",
    acc: "52%",
    topSpeed: "1180 ups",
    streak: 9,
  },
  {
    rank: 3,
    name: "rail_queen",
    rating: 2534,
    wins: 256,
    losses: 82,
    kd: "2.44",
    weapon: "Railgun",
    acc: "55%",
    topSpeed: "1120 ups",
    streak: 7,
  },
  {
    rank: 4,
    name: "rocketJump99",
    rating: 2401,
    wins: 198,
    losses: 94,
    kd: "2.11",
    weapon: "Rocket",
    acc: "38%",
    topSpeed: "1340 ups",
    streak: 5,
  },
  {
    rank: 5,
    name: "fragmaster",
    rating: 2298,
    wins: 187,
    losses: 103,
    kd: "1.92",
    weapon: "Rocket",
    acc: "41%",
    topSpeed: "1090 ups",
    streak: 4,
  },
  {
    rank: 6,
    name: "plasma_rush",
    rating: 2155,
    wins: 164,
    losses: 112,
    kd: "1.78",
    weapon: "Plasma",
    acc: "35%",
    topSpeed: "1260 ups",
    streak: 3,
  },
  {
    rank: 7,
    name: "shaft_master",
    rating: 2089,
    wins: 152,
    losses: 120,
    kd: "1.65",
    weapon: "Lightning",
    acc: "58%",
    topSpeed: "1050 ups",
    streak: 6,
  },
  {
    rank: 8,
    name: "neon_ghost",
    rating: 1987,
    wins: 141,
    losses: 131,
    kd: "1.41",
    weapon: "Gauntlet",
    acc: "100%",
    topSpeed: "980 ups",
    streak: 2,
  },
  {
    rank: 9,
    name: "strafejmp",
    rating: 1876,
    wins: 128,
    losses: 140,
    kd: "1.22",
    weapon: "Rocket",
    acc: "36%",
    topSpeed: "1410 ups",
    streak: 3,
  },
  {
    rank: 10,
    name: "warsow_fan",
    rating: 1745,
    wins: 115,
    losses: 152,
    kd: "1.08",
    weapon: "Lightning",
    acc: "45%",
    topSpeed: "1190 ups",
    streak: 2,
  },
  {
    rank: 11,
    name: "q3_veteran",
    rating: 1689,
    wins: 102,
    losses: 158,
    kd: "0.95",
    weapon: "Railgun",
    acc: "42%",
    topSpeed: "1080 ups",
    streak: 1,
  },
  {
    rank: 12,
    name: "bunny_hop",
    rating: 1534,
    wins: 88,
    losses: 167,
    kd: "0.84",
    weapon: "Rocket",
    acc: "33%",
    topSpeed: "1520 ups",
    streak: 1,
  },
];

// ═══════════════════════════════════════════════════════════════════
// LOBBY PANEL
// ═══════════════════════════════════════════════════════════════════

export class LobbyPanel extends GamePanel {
  private modesContainer: HTMLElement | null = null;
  private matchLobbyView: MatchLobbyView | null = null;
  private settingsView: FPSSettingsView | null = null;

  // Lobby server connection
  private lobbyClient: LobbyClient;
  private livePlayers: PlayerInfo[] = [];
  private playerListEl: HTMLElement | null = null;
  private playerCountBadge: HTMLElement | null = null;
  private chatMessagesEl: HTMLElement | null = null;

  private currentLobbyId: string | null = null;
  private unsubscribers: (() => void)[] = [];

  // Live matches
  private liveMatches: LiveMatchInfo[] = [];
  private matchListEl: HTMLElement | null = null;

  // Demos
  private recentDemos: DemoInfo[] = [];
  private demosArchive: DemoInfo[] = [];
  private demosGridEl: HTMLElement | null = null;
  private _preloadedLevelshots = new Set<string>();

  constructor() {
    super("PLAY");
    this.closable = false; // Main menu cannot be closed via ESC
    UIStyles.injectCSS("lobby-panel", lobbyCSSRaw);
    UIStyles.injectCSS("match-lobby", matchLobbyCSSRaw);

    // 3D Logo floating above panel
    this.enableLogo();

    // Initialize shared lobby client
    this.lobbyClient = getFpsLobbyClient();
    this.initLobbyConnection();

    // Tabs — Settings is now a tab alongside the others
    this.addTab("matchmaking", "Matchmaking", this.buildMatchmakingTab());
    this.addTab("demos", "Demos", this.buildDemosTab());
    this.addTab("leaderboard", "Leaderboard", this.buildLeaderboardTab());
    this.addTab("profile", "My Profile", this.buildProfileTab());
    this.addTab("settings", "⚙ Settings", this.buildSettingsTab());
    this.switchTab("matchmaking");
    this.onTabChange((tabId) => {
      if (tabId === "settings") {
        void this.settingsView?.refresh();
      }
    });

    // Console button in tab row
    const headerBtns = document.createElement("div");
    headerBtns.className = "lobby__header-actions";

    const consoleBtn = this.createButton("Console ~", "");
    consoleBtn.addEventListener("click", () => DebugConsole.getInstance().toggle());
    headerBtns.appendChild(consoleBtn);

    this.tabBar.appendChild(headerBtns);

    // Hide footer
    this.footerArea.style.display = "none";
  }

  // ── Lobby Server Connection ──────────────────────────────────

  private async initLobbyConnection(): Promise<void> {
    try {
      // Handle welcome — initial data dump
      this.unsubscribers.push(
        this.lobbyClient.on("welcome", (msg) => {
          console.log("[LobbyPanel] Welcome from lobby server:", msg.playerId);
          this.livePlayers = msg.onlinePlayers || [];
          this.refreshPlayerList();

          // Load live matches + recent demos, then render once
          this.liveMatches = msg.liveMatches || [];
          this.recentDemos = msg.recentDemos || [];
          this.refreshMatchList();

          // Preload levelshots for all maps in gametype pools
          const poolMaps = new Set<string>();
          for (const gt of msg.gametypes || []) {
            for (const m of gt.mapPool || []) poolMaps.add(m);
          }
          this._preloadLevelshots([...poolMaps]);

          // Load chat history
          if (msg.chatHistory && this.chatMessagesEl) {
            for (const c of msg.chatHistory) {
              this.appendChatMessage(c.from, c.text, false);
            }
          }
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

      // Chat messages
      this.unsubscribers.push(
        this.lobbyClient.on("chat:message", (msg) => {
          this.appendChatMessage(msg.from, msg.text, false);
        }),
      );

      // Lobby created (response to lobby:create)
      this.unsubscribers.push(
        this.lobbyClient.on("lobby:created", (msg) => {
          this.handleLobbyCreated(msg.lobby);
        }),
      );

      // Lobby errors
      this.unsubscribers.push(
        this.lobbyClient.on("lobby:error", (msg) => {
          console.warn("[LobbyPanel] Lobby error:", msg.error);
        }),
      );

      // Live matches updates
      this.unsubscribers.push(
        this.lobbyClient.on("matches:update", (msg) => {
          this.liveMatches = msg.matches || [];
          this.refreshMatchList();
        }),
      );

      // Match ended — server exited, return to lobby
      this.unsubscribers.push(
        this.lobbyClient.on("match:ended", (msg) => {
          console.log(`[LobbyPanel] Match ended (${msg.matchId})`);
          this.appendChatMessage("", "⚔ Match ended — returning to lobby", true);
          this.currentLobbyId = null;
          // Return to gametype cards if in match lobby view
          if (this.matchLobbyView) {
            this.showGametypeCards();
          }
        }),
      );

      // Demo archive list response
      this.unsubscribers.push(
        this.lobbyClient.on("demos:list_response", (msg) => {
          this.demosArchive = msg.demos || [];
          // Preload any new map levelshots from demo list
          const demoMaps = [...new Set<string>((msg.demos || []).map((d: DemoInfo) => d.map))];
          this._preloadLevelshots(demoMaps);
          this.refreshDemosGrid();
        }),
      );

      await ensureFpsLobbyConnection();

      // Share lobby client with DemoService so console `demolist` command works
      DemoService.getInstance().setLobbyClient(this.lobbyClient);
    } catch (err) {
      console.warn("[LobbyPanel] Could not connect to lobby server:", err);
      console.log("[LobbyPanel] Falling back to mock data");
      // Fallback: show mock data if server is not running
      this.useMockData();
    }
  }

  private useMockData(): void {
    // Populate with mock data when lobby server is unavailable
    for (const p of MOCK_PLAYERS) {
      this.livePlayers.push({
        id: p.name,
        name: p.name,
        status: p.status === "searching" ? "in_lobby" : p.status === "ingame" ? "in_match" : "online",
      });
    }
    this.refreshPlayerList();
    for (const c of MOCK_CHAT) {
      this.appendChatMessage(c.name, c.msg, !!(c as any).system);
    }
  }

  private refreshPlayerList(): void {
    if (!this.playerListEl) return;
    this.playerListEl.innerHTML = "";

    for (const p of this.livePlayers) {
      const row = document.createElement("div");
      row.className = "lobby__player";

      const dot = document.createElement("div");
      const statusClass = p.status === "in_lobby" ? "searching" : p.status === "in_match" ? "ingame" : "online";
      dot.className = `lobby__player-dot lobby__player-dot--${statusClass}`;
      row.appendChild(dot);

      const name = document.createElement("span");
      name.className = "lobby__player-name";
      name.textContent = p.name;
      row.appendChild(name);

      if (p.status === "in_lobby") {
        const badge = document.createElement("span");
        badge.className = "lobby__player-badge lobby__player-badge--search";
        badge.textContent = "IN LOBBY";
        row.appendChild(badge);
      } else if (p.status === "in_match") {
        const badge = document.createElement("span");
        badge.className = "lobby__player-badge lobby__player-badge--ingame";
        badge.textContent = "IN MATCH";
        row.appendChild(badge);
      }

      this.playerListEl.appendChild(row);
    }

    // Update badge count
    if (this.playerCountBadge) {
      this.playerCountBadge.textContent = `${this.livePlayers.length}`;
    }
  }

  private appendChatMessage(from: string, text: string, system: boolean): void {
    if (!this.chatMessagesEl) return;

    const msg = document.createElement("div");
    if (system || !from) {
      msg.className = "lobby__chat-msg lobby__chat-msg--system";
      msg.textContent = text;
    } else {
      msg.className = "lobby__chat-msg";
      const nameSpan = document.createElement("span");
      nameSpan.className = "lobby__chat-name";
      nameSpan.textContent = from;
      msg.appendChild(nameSpan);
      msg.appendChild(document.createTextNode(text));
    }
    this.chatMessagesEl.appendChild(msg);
    this.chatMessagesEl.scrollTop = this.chatMessagesEl.scrollHeight;
  }

  private handleLobbyCreated(lobby: MatchLobbyInfo): void {
    this.currentLobbyId = lobby.id;
    if (!this.modesContainer) return;
    const layout = this.modesContainer.parentElement;
    if (!layout) return;

    // Create match lobby view with real server data
    this.matchLobbyView = new MatchLobbyView(lobby.gametype, this.lobbyClient, lobby);
    this.matchLobbyView.onLeave(() => {
      if (this.currentLobbyId) {
        this.lobbyClient.leaveLobby(this.currentLobbyId);
        this.currentLobbyId = null;
      }
      this.showGametypeCards();
    });

    // Swap mode cards for match lobby
    layout.replaceChild(this.matchLobbyView.root, this.modesContainer);
    console.log(`[LobbyPanel] Opened match lobby: ${lobby.id}`);
  }

  show(): void {
    this.open();
  }
  hide(): void {
    this.close();
  }

  isVisible(): boolean {
    return this.isOpen();
  }
  setOnPlay(_cb: (mode: string) => void): void {}
  onSettingsChange(_cb: (key: string, value: any) => void): void {}

  // ═══════════════════════════════════════════════════════════════════
  // TAB 1: MATCHMAKING
  // ═══════════════════════════════════════════════════════════════════

  private buildMatchmakingTab(): HTMLElement {
    const layout = document.createElement("div");
    layout.className = "lobby__layout";

    this.modesContainer = this.buildModeCards();
    layout.appendChild(this.modesContainer);
    layout.appendChild(this.buildSocialColumn());
    layout.appendChild(this.buildChatColumn());

    return layout;
  }

  // ── Mode cards ──

  private buildModeCards(): HTMLElement {
    const container = document.createElement("div");
    container.className = "lobby__modes";
    for (const mode of GAME_MODES) {
      container.appendChild(this.buildModeCard(mode));
    }
    return container;
  }

  private buildModeCard(mode: GameMode): HTMLElement {
    const card = document.createElement("div");
    card.className = "lobby__mode-card";
    card.dataset.mode = mode.id;
    card.style.setProperty("--card-hue", mode.hue);

    const bg = document.createElement("div");
    bg.className = "lobby__mode-bg";
    if (mode.image) {
      bg.style.backgroundImage = `url(${mode.image})`;
      bg.classList.add("lobby__mode-bg--image");
    }
    card.appendChild(bg);

    const overlay = document.createElement("div");
    overlay.className = "lobby__mode-overlay";
    card.appendChild(overlay);

    const content = document.createElement("div");
    content.className = "lobby__mode-content";

    const title = document.createElement("div");
    title.className = "lobby__mode-title";
    title.textContent = mode.title;
    content.appendChild(title);

    const sub = document.createElement("div");
    sub.className = "lobby__mode-sub";
    sub.textContent = mode.subtitle;
    content.appendChild(sub);

    const queueEl = document.createElement("div");
    queueEl.className = "lobby__mode-queue";
    queueEl.textContent = mode.queued > 0 ? `${mode.queued} IN QUEUE` : "NO QUEUE";
    if (mode.queued > 0) queueEl.classList.add("lobby__mode-queue--active");
    content.appendChild(queueEl);

    const btn = document.createElement("button");
    btn.className = "lobby__find-btn";
    btn.id = `lobby-find-${mode.id}`;
    btn.textContent = "FIND MATCH";

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showMatchLobby(mode.id);
    });
    content.appendChild(btn);

    card.appendChild(content);
    card.addEventListener("click", () => this.showMatchLobby(mode.id));

    return card;
  }

  // ── Social column ──

  private buildSocialColumn(): HTMLElement {
    const col = document.createElement("div");
    col.className = "lobby__col lobby__col--social";

    const titleEl = this.sectionTitle("PLAYERS ONLINE", "0");
    this.playerCountBadge = titleEl.querySelector(".lobby__section-badge") as HTMLElement;
    col.appendChild(titleEl);
    col.appendChild(this.buildPlayerList());

    const divider = document.createElement("div");
    divider.className = "lobby__divider";
    col.appendChild(divider);

    col.appendChild(this.sectionTitle("LIVE MATCHES"));
    col.appendChild(this.buildMatchList());

    return col;
  }

  private buildPlayerList(): HTMLElement {
    const list = document.createElement("div");
    list.className = "lobby__players";
    this.playerListEl = list;
    // Will be populated by refreshPlayerList() when server data arrives
    return list;
  }

  private buildMatchList(): HTMLElement {
    const list = document.createElement("div");
    list.className = "lobby__matches";
    this.matchListEl = list;
    // Will be populated by refreshMatchList() when server data arrives
    return list;
  }

  private refreshMatchList(): void {
    if (!this.matchListEl) return;
    this.matchListEl.innerHTML = "";

    if (this.liveMatches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "lobby__chat-msg lobby__chat-msg--system";
      empty.textContent = "No live matches";
      empty.style.padding = "8px 10px";
      this.matchListEl.appendChild(empty);
      return;
    }

    for (const m of this.liveMatches) {
      const match = document.createElement("div");
      match.className = "lobby__match";

      // Elapsed time
      const elapsed = Math.floor((Date.now() - m.startedAt) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = `${mins}:${secs.toString().padStart(2, "0")}`;

      const stateLabel = m.state === "playing" ? "● LIVE" : "○ LOBBY";

      const header = document.createElement("div");
      header.className = "lobby__match-header";
      header.innerHTML = `
                <span class="lobby__match-live">${stateLabel}</span>
                <span class="lobby__match-type">${m.gametypeName}</span>
                <span class="lobby__match-time">${timeStr}</span>
            `;
      match.appendChild(header);

      const players = document.createElement("div");
      players.className = "lobby__match-players";
      players.textContent =
        m.players.length > 0 ? m.players.join(" vs ") : `${m.playerCount} player${m.playerCount !== 1 ? "s" : ""}`;
      match.appendChild(players);

      const footer = document.createElement("div");
      footer.className = "lobby__match-footer";
      footer.innerHTML = `
                <span class="lobby__match-map">${m.mapDisplayName || m.gametype}</span>
                <span class="lobby__match-score">${m.playerCount}/${m.maxPlayers}</span>
            `;

      if (m.state === "playing") {
        const watchBtn = document.createElement("button");
        watchBtn.className = "lobby__watch-btn";
        watchBtn.textContent = "WATCH";
        watchBtn.addEventListener("click", () => {
          if (m.serverUrl) {
            const overlay = new ConnectingOverlay();
            overlay.show(m.serverUrl, true); // asSpectator = true
          } else {
            console.warn("[LobbyPanel] No server URL for match", m.id);
          }
        });
        footer.appendChild(watchBtn);
      } else {
        const joinBtn = document.createElement("button");
        joinBtn.className = "lobby__watch-btn";
        joinBtn.textContent = "JOIN";
        joinBtn.addEventListener("click", () => {
          this.lobbyClient.joinLobby(m.id);
        });
        footer.appendChild(joinBtn);
      }

      match.appendChild(footer);
      this.matchListEl.appendChild(match);
    }

    // ── Append recent demos below live matches ──
    if (this.recentDemos.length > 0) {
      const demoHeader = document.createElement("div");
      demoHeader.className = "lobby__chat-msg lobby__chat-msg--system";
      demoHeader.textContent = "RECENT DEMOS";
      demoHeader.style.padding = "10px 10px 4px";
      demoHeader.style.fontSize = "10px";
      demoHeader.style.letterSpacing = "0.1em";
      demoHeader.style.opacity = "0.5";
      this.matchListEl.appendChild(demoHeader);

      for (const d of this.recentDemos.slice(0, 10)) {
        const demo = document.createElement("div");
        demo.className = "lobby__match lobby__match--demo";

        // Duration
        const totalSecs = Math.floor(d.durationMs / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        const durationStr = `${mins}:${secs.toString().padStart(2, "0")}`;

        const header = document.createElement("div");
        header.className = "lobby__match-header";
        header.innerHTML = `
                    <span class="lobby__match-demo-label">▶ DEMO</span>
                    <span class="lobby__match-type">${d.gametype.toUpperCase()}</span>
                    <span class="lobby__match-time">${durationStr}</span>
                `;
        demo.appendChild(header);

        const players = document.createElement("div");
        players.className = "lobby__match-players";
        players.textContent = d.players.length > 0 ? d.players.join(" vs ") : "Unknown";
        demo.appendChild(players);

        const footer = document.createElement("div");
        footer.className = "lobby__match-footer";

        // Date string
        const dateStr = new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        footer.innerHTML = `
                    <span class="lobby__match-map">${d.mapDisplayName}</span>
                    <span class="lobby__match-score">${dateStr}</span>
                `;

        const viewBtn = document.createElement("button");
        viewBtn.className = "lobby__watch-btn lobby__watch-btn--demo";
        viewBtn.textContent = "VIEW DEMO";
        viewBtn.addEventListener("click", () => {
          // Phase 1: download demo file
          const link = document.createElement("a");
          link.href = `/data/demos/${d.filename}`;
          link.download = d.filename;
          link.click();
        });
        footer.appendChild(viewBtn);

        demo.appendChild(footer);
        this.matchListEl.appendChild(demo);
      }
    }
  }

  // ── Chat column ──

  private buildChatColumn(): HTMLElement {
    const col = document.createElement("div");
    col.className = "lobby__col lobby__col--chat";

    col.appendChild(this.sectionTitle("LOBBY CHAT"));

    const messages = document.createElement("div");
    messages.className = "lobby__chat-messages";
    this.chatMessagesEl = messages;
    // Will be populated by welcome chatHistory and live chat:message events
    col.appendChild(messages);

    const inputWrap = document.createElement("div");
    inputWrap.className = "lobby__chat-input-wrap";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "lobby__chat-input";
    input.placeholder = "Type a message...";
    input.spellcheck = false;
    input.autocomplete = "off";

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && input.value.trim()) {
        this.lobbyClient.chatSend(input.value.trim());
        input.value = "";
      }
    });

    inputWrap.appendChild(input);
    col.appendChild(inputWrap);

    return col;
  }

  // ═══════════════════════════════════════════════════════════════════
  // TAB: DEMOS
  // ═══════════════════════════════════════════════════════════════════

  private buildDemosTab(): HTMLElement {
    UIStyles.injectCSS("demo-tab", demoTabCSSRaw);

    const container = document.createElement("div");
    container.className = "lobby__demos";

    const header = document.createElement("div");
    header.className = "lobby__demos-header";
    header.innerHTML = `
            <span class="lobby__demos-title">DEMO ARCHIVE</span>
            <span class="lobby__demos-count"></span>
        `;
    container.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "lobby__demos-grid";
    this.demosGridEl = grid;
    container.appendChild(grid);

    // Request demo list when tab is activated
    const origSwitchTab = this.switchTab.bind(this);
    this.switchTab = (tabId: string) => {
      origSwitchTab(tabId);
      if (tabId === "demos") {
        this.lobbyClient.requestDemoList(64);
      }
    };

    return container;
  }

  private refreshDemosGrid(): void {
    if (!this.demosGridEl) return;
    this.demosGridEl.innerHTML = "";

    // Update count badge
    const countEl = this.demosGridEl.parentElement?.querySelector(".lobby__demos-count");
    if (countEl) countEl.textContent = `${this.demosArchive.length} demos`;

    if (this.demosArchive.length === 0) {
      const empty = document.createElement("div");
      empty.className = "lobby__demos-empty";
      empty.textContent = "No recorded demos yet. Play some matches!";
      empty.style.gridColumn = "1 / -1";
      this.demosGridEl.appendChild(empty);
      return;
    }

    // Map gametype → hue for fallback gradient
    const gametypeHues: Record<string, string> = {
      duel: "180",
      deathmatch: "45",
      tdm: "320",
      team: "320",
      ffa: "45",
    };

    for (const d of this.demosArchive) {
      const card = document.createElement("div");
      card.className = "lobby__demo-card";

      // Banner — levelshot image or gradient fallback
      const hue = gametypeHues[d.gametype] || "200";
      const banner = document.createElement("div");
      banner.className = "lobby__demo-card-banner";

      // Always set gradient as base — levelshot overlays on top
      const fallbackGradient = `linear-gradient(135deg, hsla(${hue},60%,40%,0.25), hsla(${hue},40%,20%,0.1))`;
      banner.style.background = fallbackGradient;

      if (d.levelshot) {
        banner.classList.add("lobby__demo-card-banner--has-image");
        banner.style.background = `url(${d.levelshot}) center/cover, ${fallbackGradient}`;
        // Remove image class if levelshot 404s (disables CRT scanlines on fallback)
        const testImg = new Image();
        testImg.onerror = () => {
          banner.classList.remove("lobby__demo-card-banner--has-image");
          banner.style.background = fallbackGradient;
        };
        testImg.src = d.levelshot;
      }

      // Map name — secondary, small label above players
      const mapName = document.createElement("span");
      mapName.className = "lobby__demo-card-map";
      mapName.textContent = d.mapDisplayName;
      banner.appendChild(mapName);

      // Player names — primary heading inside banner
      const players = document.createElement("div");
      players.className = "lobby__demo-card-players";
      if (d.players.length > 4) {
        players.textContent = d.players.slice(0, 4).join(" vs ") + ` +${d.players.length - 4}`;
      } else {
        players.textContent = d.players.length > 0 ? d.players.join(" vs ") : "Unknown";
      }
      banner.appendChild(players);

      // Gametype chip
      const gametypeLabel = document.createElement("span");
      gametypeLabel.className = "lobby__demo-card-gametype";
      gametypeLabel.textContent = d.gametype.toUpperCase();
      banner.appendChild(gametypeLabel);

      card.appendChild(banner);

      // Body — metadata row
      const body = document.createElement("div");
      body.className = "lobby__demo-card-body";

      const totalSecs = Math.floor(d.durationMs / 1000);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      const durationStr = `${mins}:${secs.toString().padStart(2, "0")}`;

      const dateStr = new Date(d.date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const meta = document.createElement("div");
      meta.className = "lobby__demo-card-meta";
      meta.innerHTML = `<span>${durationStr}</span><span>${dateStr}</span><span>${d.sizeMB} MB</span>`;
      body.appendChild(meta);

      card.appendChild(body);

      // Button row: ▶ PLAY DEMO  |  ⚡ HIGHLIGHTS
      const btnRow = document.createElement("div");
      btnRow.className = "lobby__demo-card-btn-row";

      const playBtn = document.createElement("button");
      playBtn.className = "lobby__demo-card-btn";
      playBtn.textContent = "▶ PLAY";
      playBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        playBtn.disabled = true;
        playBtn.textContent = "LOADING…";
        try {
          const service = DemoService.getInstance();
          await service.fetchAndLoad(d.filename);
          const viewer = new DemoViewer();
          await service.loadAndPlayNormal(viewer);
          this.hide();
        } catch (err) {
          console.error("[LobbyPanel] Failed to load demo:", err);
          this._showDemoError(card, err instanceof Error ? err.message : String(err));
        } finally {
          playBtn.disabled = false;
          playBtn.textContent = "▶ PLAY";
        }
      });
      btnRow.appendChild(playBtn);

      const highlightBtn = document.createElement("button");
      highlightBtn.className = "lobby__demo-card-btn lobby__demo-card-btn--highlight";
      highlightBtn.textContent = "⚡ HIGHLIGHTS";
      highlightBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        DurationPickerModal.show(async (minutes) => {
          highlightBtn.disabled = true;
          highlightBtn.textContent = "LOADING…";
          try {
            const service = DemoService.getInstance();
            await service.fetchAndLoad(d.filename);
            const viewer = new DemoViewer();
            const cameraSystem = CameraSystem.getInstance();
            await service.loadAndPlayCinematic(viewer, cameraSystem, minutes);
            this.hide();
          } catch (err) {
            console.error("[LobbyPanel] Failed to load demo for highlights:", err);
            this._showDemoError(card, err instanceof Error ? err.message : String(err));
          } finally {
            highlightBtn.disabled = false;
            highlightBtn.textContent = "⚡ HIGHLIGHTS";
          }
        });
      });
      btnRow.appendChild(highlightBtn);

      card.appendChild(btnRow);

      this.demosGridEl.appendChild(card);
    }
  }

  /** Best-effort preload of levelshot images for given map names */
  private _preloadLevelshots(maps: string[]): void {
    for (const map of maps) {
      if (this._preloadedLevelshots.has(map)) continue;
      this._preloadedLevelshots.add(map);
      const img = new Image();
      img.src = `/data/levelshots/${map}.png`;
      // No-op on success or error — purely warming the browser cache
    }
  }

  /** Show a temporary error toast on a demo card */
  private _showDemoError(card: HTMLElement, message: string): void {
    // Remove any previous error on this card
    card.querySelector(".lobby__demo-card-error")?.remove();
    const el = document.createElement("div");
    el.className = "lobby__demo-card-error";
    el.textContent = message;
    card.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TAB 2: LEADERBOARD
  // ═══════════════════════════════════════════════════════════════════

  private buildLeaderboardTab(): HTMLElement {
    const container = document.createElement("div");
    container.className = "lobby__leaderboard";

    // Season info
    const seasonBar = document.createElement("div");
    seasonBar.className = "lobby__lb-season";
    seasonBar.innerHTML = `
            <span class="lobby__lb-season-label">SEASON 1</span>
            <span class="lobby__lb-season-mode">DUEL 1v1</span>
            <span class="lobby__lb-season-ends">Ends in 24d 7h</span>
        `;
    container.appendChild(seasonBar);

    // Table
    const table = document.createElement("div");
    table.className = "lobby__lb-table";

    // Header row
    const headerRow = document.createElement("div");
    headerRow.className = "lobby__lb-row lobby__lb-row--header";
    headerRow.innerHTML = `
            <span class="lobby__lb-cell lobby__lb-cell--rank">#</span>
            <span class="lobby__lb-cell lobby__lb-cell--name">PLAYER</span>
            <span class="lobby__lb-cell lobby__lb-cell--rating">RATING</span>
            <span class="lobby__lb-cell lobby__lb-cell--wl">W / L</span>
            <span class="lobby__lb-cell lobby__lb-cell--kd">K/D</span>
            <span class="lobby__lb-cell lobby__lb-cell--weapon">WEAPON</span>
            <span class="lobby__lb-cell lobby__lb-cell--acc">ACC</span>
            <span class="lobby__lb-cell lobby__lb-cell--speed">TOP SPEED</span>
            <span class="lobby__lb-cell lobby__lb-cell--streak">STREAK</span>
        `;
    table.appendChild(headerRow);

    // Data rows
    for (const p of MOCK_LEADERBOARD) {
      const row = document.createElement("div");
      row.className = "lobby__lb-row";

      // Highlight top 3
      if (p.rank <= 3) row.classList.add(`lobby__lb-row--top${p.rank}`);

      const rankClass = p.rank <= 3 ? ` lobby__lb-rank--${p.rank}` : "";
      row.innerHTML = `
                <span class="lobby__lb-cell lobby__lb-cell--rank"><span class="lobby__lb-rank${rankClass}">${p.rank}</span></span>
                <span class="lobby__lb-cell lobby__lb-cell--name">${p.name}</span>
                <span class="lobby__lb-cell lobby__lb-cell--rating">${p.rating}</span>
                <span class="lobby__lb-cell lobby__lb-cell--wl"><span class="lobby__lb-wins">${p.wins}</span> / <span class="lobby__lb-losses">${p.losses}</span></span>
                <span class="lobby__lb-cell lobby__lb-cell--kd">${p.kd}</span>
                <span class="lobby__lb-cell lobby__lb-cell--weapon">${p.weapon}</span>
                <span class="lobby__lb-cell lobby__lb-cell--acc">${p.acc}</span>
                <span class="lobby__lb-cell lobby__lb-cell--speed">${p.topSpeed}</span>
                <span class="lobby__lb-cell lobby__lb-cell--streak">${p.streak > 1 ? `🔥 ${p.streak}` : p.streak}</span>
            `;
      table.appendChild(row);
    }

    container.appendChild(table);

    // Fun stats at bottom
    const funStats = document.createElement("div");
    funStats.className = "lobby__lb-fun";
    funStats.innerHTML = `
            <div class="lobby__lb-fun-stat">
                <span class="lobby__lb-fun-value">1520 ups</span>
                <span class="lobby__lb-fun-label">TOP SPEED RECORD</span>
                <span class="lobby__lb-fun-by">by bunny_hop</span>
            </div>
            <div class="lobby__lb-fun-stat">
                <span class="lobby__lb-fun-value">14</span>
                <span class="lobby__lb-fun-label">LONGEST WIN STREAK</span>
                <span class="lobby__lb-fun-by">by zeroQL</span>
            </div>
            <div class="lobby__lb-fun-stat">
                <span class="lobby__lb-fun-value">100%</span>
                <span class="lobby__lb-fun-label">BEST ACCURACY</span>
                <span class="lobby__lb-fun-by">by neon_ghost (Gauntlet)</span>
            </div>
            <div class="lobby__lb-fun-stat">
                <span class="lobby__lb-fun-value">342</span>
                <span class="lobby__lb-fun-label">MOST VICTORIES</span>
                <span class="lobby__lb-fun-by">by zeroQL</span>
            </div>
        `;
    container.appendChild(funStats);

    return container;
  }

  // ═══════════════════════════════════════════════════════════════════
  // TAB 3: MY PROFILE
  // ═══════════════════════════════════════════════════════════════════

  private buildProfileTab(): HTMLElement {
    const container = document.createElement("div");
    container.className = "lobby__profile";

    // ── Left: Player identity ──
    const identity = document.createElement("div");
    identity.className = "lobby__profile-identity";

    // Avatar/rank area
    const avatar = document.createElement("div");
    avatar.className = "lobby__profile-avatar";
    avatar.innerHTML = `
            <div class="lobby__profile-rank-badge">
                <span class="lobby__profile-rank-num">#4</span>
            </div>
        `;
    identity.appendChild(avatar);

    // Player name (editable)
    const nameSection = document.createElement("div");
    nameSection.className = "lobby__profile-name-section";

    const nameLabel = document.createElement("div");
    nameLabel.className = "lobby__profile-label";
    nameLabel.textContent = "PLAYER NAME";
    nameSection.appendChild(nameLabel);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "lobby__profile-name-input";
    nameInput.value = "Player_001";
    nameInput.spellcheck = false;
    nameInput.addEventListener("keydown", (e) => e.stopPropagation());
    nameSection.appendChild(nameInput);

    const nameHint = document.createElement("div");
    nameHint.className = "lobby__profile-hint";
    nameHint.textContent = "Press Enter to change";
    nameSection.appendChild(nameHint);

    identity.appendChild(nameSection);

    // Rating display
    const ratingSection = document.createElement("div");
    ratingSection.className = "lobby__profile-rating";
    ratingSection.innerHTML = `
            <div class="lobby__profile-label">RATING</div>
            <div class="lobby__profile-rating-value">2401</div>
            <div class="lobby__profile-rating-change">+24 this week</div>
        `;
    identity.appendChild(ratingSection);

    container.appendChild(identity);

    // ── Center: Stats ──
    const stats = document.createElement("div");
    stats.className = "lobby__profile-stats";

    stats.appendChild(this.sectionTitle("STATISTICS"));

    const statsGrid = document.createElement("div");
    statsGrid.className = "lobby__profile-stats-grid";

    const statItems = [
      { label: "MATCHES", value: "292" },
      { label: "WINS", value: "198" },
      { label: "LOSSES", value: "94" },
      { label: "WIN RATE", value: "67.8%" },
      { label: "K/D RATIO", value: "2.11" },
      { label: "TOTAL KILLS", value: "4,821" },
      { label: "TOTAL DEATHS", value: "2,285" },
      { label: "ACCURACY", value: "38.4%" },
      { label: "TOP SPEED", value: "1,340 ups" },
      { label: "PLAY TIME", value: "127h 42m" },
      { label: "WIN STREAK", value: "5" },
      { label: "FAV WEAPON", value: "Rocket" },
    ];

    for (const s of statItems) {
      const item = document.createElement("div");
      item.className = "lobby__profile-stat";
      item.innerHTML = `
                <span class="lobby__profile-stat-value">${s.value}</span>
                <span class="lobby__profile-stat-label">${s.label}</span>
            `;
      statsGrid.appendChild(item);
    }

    stats.appendChild(statsGrid);
    container.appendChild(stats);

    // ── Right: Quick settings ──
    const settings = document.createElement("div");
    settings.className = "lobby__profile-settings";

    settings.appendChild(this.sectionTitle("QUICK SETTINGS"));

    const settingsList = document.createElement("div");
    settingsList.className = "lobby__profile-settings-list";

    const settingItems = [
      { label: "FOV", value: "110" },
      { label: "Sensitivity", value: "5.0" },
      { label: "Name", value: "Player_001" },
      { label: "Crosshair", value: "Cross" },
    ];

    for (const s of settingItems) {
      const row = document.createElement("div");
      row.className = "lobby__profile-setting-row";
      row.innerHTML = `
                <span class="lobby__profile-setting-label">${s.label}</span>
                <span class="lobby__profile-setting-value">${s.value}</span>
            `;
      settingsList.appendChild(row);
    }

    settings.appendChild(settingsList);

    // Open full settings button
    const fullSettingsBtn = document.createElement("button");
    fullSettingsBtn.className = "lobby__profile-settings-btn";
    fullSettingsBtn.textContent = "⚙ OPEN FULL SETTINGS";
    fullSettingsBtn.addEventListener("click", () => this.switchTab("settings"));
    settings.appendChild(fullSettingsBtn);

    container.appendChild(settings);

    return container;
  }

  // ═══════════════════════════════════════════════════════════════════
  // TAB 4: SETTINGS
  // ═══════════════════════════════════════════════════════════════════

  private buildSettingsTab(): HTMLElement {
    if (!this.settingsView) {
      this.settingsView = new FPSSettingsView();
      void this.settingsView.refresh();
    }

    const container = document.createElement("div");
    container.className = "lobby__settings-tab";
    container.appendChild(this.settingsView.getElement());
    return container;
  }

  private sectionTitle(text: string, badge?: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "lobby__section-title";
    el.appendChild(document.createTextNode(text));
    if (badge) {
      const b = document.createElement("span");
      b.className = "lobby__section-badge";
      b.textContent = badge;
      el.appendChild(b);
    }
    return el;
  }

  private showMatchLobby(gametypeId: string): void {
    if (!this.modesContainer) return;

    // If lobby server is connected, join queue → server creates lobby immediately
    if (this.lobbyClient.connected) {
      this.lobbyClient.joinQueue(gametypeId);
      // Server sends lobby:created → handleLobbyCreated opens lobby view
      return;
    }

    // Fallback: local mock lobby
    const layout = this.modesContainer.parentElement;
    if (!layout) return;
    this.matchLobbyView = new MatchLobbyView(gametypeId);
    this.matchLobbyView.onLeave(() => this.showGametypeCards());
    layout.replaceChild(this.matchLobbyView.root, this.modesContainer);
    console.log(`[LobbyPanel] Opened mock match lobby for: ${gametypeId}`);
  }

  private showGametypeCards(): void {
    if (!this.matchLobbyView || !this.modesContainer) return;
    const layout = this.matchLobbyView.root.parentElement;
    if (!layout) return;

    // Swap match lobby back to mode cards
    layout.replaceChild(this.modesContainer, this.matchLobbyView.root);
    this.matchLobbyView = null;
    this.currentLobbyId = null;

    console.log(`[LobbyPanel] Returned to gametype cards`);
  }

  public override destroy(): void {
    this.settingsView?.destroy();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    super.destroy();
  }
}
