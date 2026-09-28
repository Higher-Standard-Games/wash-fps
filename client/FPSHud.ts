/**
 * FPSHud - FPS Game HUD Manager
 *
 * Creates and manages the FPS HUD overlay with Washiki Washoi visual style.
 * Handles:
 * - Injecting WashikiTheme CSS and loading fonts
 * - Creating the HUD container with anchor areas
 * - Creating and managing HUD widgets (health, armor, ammo, etc.)
 * - Binding widgets to HUDState data
 * - Update loop for live data
 *
 * Widget implementations are in ./hud/widgets/
 */

import { GamePaths } from "../../../engine/core/GamePaths";
import { log } from "../../../engine/core/Log";
// Import CSS as raw string (Vite)
import washikiTheme from "../../../engine/ui/hud/styles/WashikiTheme.css?raw";
import { UIStyles } from "../../../engine/ui/UIStyles";
import { UITheme } from "../../../engine/ui/UITheme";
import { getWeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import { toClientKey } from "../ClientEntityKey";
import { HUDState } from "./HUDState";
import { MatchPhase, MatchStateManager } from "./MatchStateManager";

// Re-export FPSHudWidget interface for backwards compatibility
export type { FPSHudWidget } from "./hud/HudWidget";

import type { FPSHudWidget } from "./hud/HudWidget";
import { FPSAirMeter } from "./hud/widgets/AirMeter";
import { FPSAmmoCounter } from "./hud/widgets/AmmoCounter";
import { FPSAmmoWarning } from "./hud/widgets/AmmoWarning";
import { FPSBombStatus } from "./hud/widgets/BombStatus";
import { FPSChat } from "./hud/widgets/Chat";
import { FPSDamageIndicators } from "./hud/widgets/DamageIndicators";
import { FPSDeathScreen } from "./hud/widgets/DeathScreen";
import { FPSFragCounter } from "./hud/widgets/FragCounter";
import { FPSFragMessage } from "./hud/widgets/FragMessage";
import { FPSGametypeBadge } from "./hud/widgets/GametypeBadge";
import { FPSPauseMenu } from "./hud/widgets/PauseMenu";
import { FPSPhaseMessage } from "./hud/widgets/PhaseMessage";
import { FPSPickupToast } from "./hud/widgets/PickupToast";
import { FPSPowerupTimer } from "./hud/widgets/PowerupTimer";
import { FPSReadyBar } from "./hud/widgets/ReadyBar";
import { FPSRoundResult } from "./hud/widgets/RoundResult";
// Overlay / dialog widgets
import { FPSScoreboard } from "./hud/widgets/Scoreboard";
import { FPSSettingsOverlay } from "./hud/widgets/SettingsOverlay";
import { FPSTimer } from "./hud/widgets/Timer";
// Import widget classes
import { FPSVitalsBlock } from "./hud/widgets/VitalsBlock";
import { FPSWeaponSlots } from "./hud/widgets/WeaponSlots";

/**
 * HUD anchor positions
 */
type FPSHudArea =
  | "top-left"
  | "top-center"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export class FPSHud {
  private static instance: FPSHud | null = null;

  private container: HTMLElement | null = null;
  private areas: Map<FPSHudArea, HTMLElement> = new Map();
  private widgets: Map<string, FPSHudWidget> = new Map();
  private updateInterval: number | null = null;
  private running: boolean = false;
  private fontsLoaded: boolean = false;

  // Phase 3: Standalone overlays (not area-based widgets)
  private _scoreboard: FPSScoreboard | null = null;
  private _chat: FPSChat | null = null;
  private _damageIndicators: FPSDamageIndicators | null = null;

  // Phase 4: Dialogs & Menus
  private _pauseMenu: FPSPauseMenu | null = null;
  private _settings: FPSSettingsOverlay | null = null;
  private _pointerLockHandler: (() => void) | null = null;
  private _chatKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Single-match post-game: timer for the ~6s "open up" beat (mouse+chat+return). */
  private _openUpTimer: number | null = null;

  private constructor() {}

  public static getInstance(): FPSHud {
    if (!FPSHud.instance) {
      FPSHud.instance = new FPSHud();
    }
    return FPSHud.instance;
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize the FPS HUD system
   */
  public async init(): Promise<void> {
    console.log("[FPSHud] Initializing...");

    // 1. Inject WashikiTheme CSS
    UIStyles.injectCSS("washiki-theme", washikiTheme);

    // 2. Load fonts
    await this.loadFonts();

    // 3. Create HUD container and anchor areas
    this.createContainer();

    // 4. Create core widgets
    this.createCoreWidgets();

    // 5. Create standalone overlays
    this._scoreboard = new FPSScoreboard();
    this._chat = new FPSChat();
    this._damageIndicators = new FPSDamageIndicators();

    // Post-game screen: the match result takes over the screen. The gameplay
    // HUD (vitals/ammo/timer/death screen/kill feed — the whole container) is
    // hidden; only the winner slam + locked board (outside the container) and
    // the 3D showcase remain. Aim is locked (pointer lock stays held). All
    // undone when the next warmup begins.
    MatchStateManager.getInstance().onPhaseChange((newPhase) => {
      if (!this._scoreboard) return;
      const postGame = newPhase === MatchPhase.PostGame;

      if (postGame) {
        const mgr = MatchStateManager.getInstance();
        const winner = mgr.winner;
        const title = winner && winner.kind !== "draw" && winner.name ? `${winner.name} wins!` : "Draw!";
        // Winner key in the scoreboard's playerId format ("player_<id>") — the
        // board renders the winner's stat panel next to the showcase model.
        const winnerId = mgr.resolveWinnerPlayerId();
        const winnerName = winner && winner.kind !== "draw" ? (winner.name ?? null) : null;
        this._scoreboard.setPostGame(title.toUpperCase(), winnerId ? toClientKey(winnerId) : null, winnerName);
        this.hide(); // gameplay HUD off — the result owns the screen
        // The pickup prompt is body-appended (outside the container) and its
        // proximity driver is frozen with input — force it away for the screen.
        import("../world/PickupPrompt")
          .then(({ hidePickupPrompt }) => {
            hidePickupPrompt("pickup");
            hidePickupPrompt("dropped");
          })
          .catch(() => {});

        // Single-match flow: after the celebration beat, the screen "opens up"
        // — mouse cursor back (pause menu stays suppressed while the board is
        // up), chat ready for banter, and the way home. The server releases
        // bots at +10s and closes stragglers at +120s; the lobby is already
        // reset and waiting (docs/research/single_game_server_lobby.md).
        if (mgr.flow === "single") {
          this._openUpTimer = window.setTimeout(() => {
            this._openUpTimer = null;
            document.exitPointerLock();
            this._chat?.openInput();
            this._scoreboard?.setReturnAction(() => {
              // Navigate to the lobby deep link (?lobby=<id>, stashed by
              // MatchLobbyView at match start) — LobbyPanel auto-joins it on
              // boot. The emptied server exits via shutdownOnEmpty. Fall back
              // to a plain reload when no lobby is known (dev CLI joins).
              const returnLobby = sessionStorage.getItem("shag.return_lobby");
              if (returnLobby) {
                const returnUrl = new URL(window.location.origin);
                returnUrl.searchParams.set("lobby", returnLobby);
                const inviteToken = sessionStorage.getItem(`shag.private_invite.${returnLobby}`);
                if (inviteToken) returnUrl.searchParams.set("invite", inviteToken);
                window.location.href = returnUrl.href;
              } else {
                window.location.reload();
              }
            });
          }, 6000);
        }
      } else {
        if (this._openUpTimer !== null) {
          clearTimeout(this._openUpTimer);
          this._openUpTimer = null;
        }
        this._scoreboard.setPostGame(null);
        this.show();
      }

      // Freeze/unfreeze mouse-look AND all gameplay input (movement/firing) on the
      // active FPS camera controller. The controller predicts movement and fires
      // straight from raw input, bypassing the server gate and the sendInput strip,
      // so without the gameplay freeze the player keeps walking/swinging on the end
      // screen. Chat + leave-lobby stay live (UI layer, not the controller).
      import("../../../engine/camera/CameraSystem")
        .then(({ CameraSystem }) => {
          const controller = CameraSystem.getInstance().getActiveController();
          // biome-ignore lint/suspicious/noExplicitAny: optional controller capability
          (controller as any)?.setLookFrozen?.(postGame);
          // biome-ignore lint/suspicious/noExplicitAny: optional controller capability
          (controller as any)?.setGameplayFrozen?.(postGame);
        })
        .catch(() => {});
    });

    // Wire chat: T opens talk mode (Q3 messagemode — pointer lock stays held,
    // mouse look keeps working; game binds are suppressed by the InputSystem
    // text-field guard while the input has focus). Enter sends via the server
    // round-trip (no local echo), Esc cancels — both handled inside FPSChat.
    this._chat.onSend((text) => {
      import("../Game")
        .then(({ Game }) => Game.getInstance().sendChat(text))
        .catch((e) => log.warn("FPSChat", "chat send failed:", e));
    });
    this._chatKeyHandler = (e: KeyboardEvent) => {
      // T (Q3 messagemode habit) or Enter (modern habit) both open talk mode.
      if ((e.code !== "KeyT" && e.code !== "Enter" && e.code !== "NumpadEnter") || e.repeat) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (!this._chat || this._chat.isInputActive()) return;
      // Only in gameplay: pointer locked, no menus/console/text fields open.
      // Exception: the single-match post-game deliberately releases pointer
      // lock (open-up beat) — chat must stay reopenable for the banter.
      if (!document.pointerLockElement && !MatchStateManager.getInstance().isPostGame()) return;
      if (this._pauseMenu?.isOpen() || this._settings?.isOpen()) return;
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      e.preventDefault(); // don't leak the "t" into the input
      e.stopPropagation();
      this._chat.openInput();
    };
    document.addEventListener("keydown", this._chatKeyHandler, true);

    // 6. Create dialogs & menus
    this._pauseMenu = new FPSPauseMenu();
    this._settings = new FPSSettingsOverlay();

    // Wire Settings button in pause menu to open settings
    this._pauseMenu.onSettings(() => {
      this._pauseMenu?.close();
      this._settings?.open();
    });

    // Back from settings is back to the match menu, while the pointer is free
    this._settings.onClose(() => {
      if (!document.pointerLockElement) this.showMatchMenu();
    });

    // Wire Resume -> re-request pointer lock (closes menu via onClose callback)
    this._pauseMenu.onResume(() => {
      const canvas = document.querySelector("canvas");
      if (canvas) {
        canvas.requestPointerLock();
      }
    });

    // Wire Disconnect -> reload page (return to lobby)
    this._pauseMenu.onDisconnect(() => {
      window.location.reload();
    });

    // Wire Go Spectator -> switch to spectator mode
    this._pauseMenu.onGoSpectate(async () => {
      const { Game } = await import("../Game");
      const gm = Game.getInstance();
      gm.goSpectator();
    });

    // Wire Join Game -> join from spectator mode (same as SpectatorOverlay)
    this._pauseMenu.onJoinGame(async (teamId?: string) => {
      const { Game } = await import("../Game");
      const gm = Game.getInstance();
      gm.joinGame(teamId);
    });

    // 7. Listen for pointer lock changes (ESC releases pointer lock -> show pause menu)
    this._pointerLockHandler = () => {
      if (!document.pointerLockElement) {
        // Pointer lock was lost (ESC pressed) — show the match menu
        this.showMatchMenu();
      } else {
        // Pointer lock was acquired — close pause menu
        this._pauseMenu?.close();
      }
    };
    document.addEventListener("pointerlockchange", this._pointerLockHandler);

    console.log(`[FPSHud] Initialized with ${this.widgets.size} widgets + overlays + dialogs`);
  }

  /**
   * The match menu, with the keys for where the player is: Join for a
   * spectator, Resume and Spectate for a player. Not over the scoreboard or
   * the settings.
   */
  private showMatchMenu(): void {
    import("../Game")
      .then(({ Game }) => {
        const state = Game.getInstance().getPlayerState();
        if (this._scoreboard?.isVisible() || this._settings?.isOpen()) return;
        this._pauseMenu?.setSpectateVisible(state === "playing");
        this._pauseMenu?.setResumeVisible(state !== "spectator");
        this._pauseMenu?.setJoinVisible(state === "spectator");
        this._pauseMenu?.open();
      })
      .catch(() => {
        /* ignore */
      });
  }

  /**
   * Load Orbitron and Rajdhani fonts locally
   */
  private async loadFonts(): Promise<void> {
    const theme = UITheme.getInstance();
    const gamePaths = GamePaths.getInstance();

    // Orbitron (display font) - variable font or static weights
    const orbitronWeights = [
      { weight: "400", file: "Orbitron-Regular.ttf" },
      { weight: "500", file: "Orbitron-Medium.ttf" },
      { weight: "600", file: "Orbitron-SemiBold.ttf" },
      { weight: "700", file: "Orbitron-Bold.ttf" },
      { weight: "800", file: "Orbitron-ExtraBold.ttf" },
      { weight: "900", file: "Orbitron-Black.ttf" },
    ];

    let orbitronLoaded = 0;
    for (const { weight, file } of orbitronWeights) {
      const fontPath = gamePaths.engine(`fonts/Orbitron/static/${file}`);
      const success = await theme.loadFont("Orbitron", fontPath, weight, true);
      if (success) orbitronLoaded++;
    }
    console.log(`[FPSHud] Orbitron font loaded (${orbitronLoaded}/${orbitronWeights.length} weights)`);

    // Rajdhani (body font)
    const rajdhaniWeights = [
      { weight: "300", file: "Rajdhani-Light.ttf" },
      { weight: "400", file: "Rajdhani-Regular.ttf" },
      { weight: "500", file: "Rajdhani-Medium.ttf" },
      { weight: "600", file: "Rajdhani-SemiBold.ttf" },
      { weight: "700", file: "Rajdhani-Bold.ttf" },
    ];

    let rajdhaniLoaded = 0;
    for (const { weight, file } of rajdhaniWeights) {
      const fontPath = gamePaths.engine(`fonts/Rajdhani/${file}`);
      const success = await theme.loadFont("Rajdhani", fontPath, weight, true);
      if (success) rajdhaniLoaded++;
    }
    console.log(`[FPSHud] Rajdhani font loaded (${rajdhaniLoaded}/${rajdhaniWeights.length} weights)`);

    this.fontsLoaded = orbitronLoaded > 0 && rajdhaniLoaded > 0;
    if (!this.fontsLoaded) {
      console.warn("[FPSHud] Some fonts failed to load — HUD will use fallback fonts");
    }
  }

  // ===========================================================================
  // Container & Layout
  // ===========================================================================

  /**
   * Create the HUD container and 9 anchor areas
   */
  private createContainer(): void {
    this.container = document.createElement("div");
    this.container.id = "fps-hud";
    this.container.className = "fps-hud-container";
    document.body.appendChild(this.container);

    // Non-bottom positions are direct children
    const topAndMiddle: FPSHudArea[] = ["top-left", "top-center", "top-right", "left", "center", "right"];

    for (const pos of topAndMiddle) {
      const area = document.createElement("div");
      area.className = `fps-hud-area fps-hud-${pos}`;
      area.dataset.hudArea = pos;
      this.container.appendChild(area);
      this.areas.set(pos, area);
    }

    // Bottom bar wrapper — spans full width, contains bottom zones
    const bottomBar = document.createElement("div");
    bottomBar.className = "fps-hud-bottom-bar";
    this.container.appendChild(bottomBar);

    const bottomPositions: FPSHudArea[] = ["bottom-left", "bottom-center", "bottom-right"];

    for (const pos of bottomPositions) {
      const area = document.createElement("div");
      area.className = `fps-hud-area fps-hud-${pos}`;
      area.dataset.hudArea = pos;
      bottomBar.appendChild(area);
      this.areas.set(pos, area);
    }
  }

  /**
   * Add a widget to a specific area
   */
  public addWidget(id: string, widget: FPSHudWidget, area: FPSHudArea): void {
    const areaEl = this.areas.get(area);
    if (!areaEl) {
      console.warn(`[FPSHud] Area '${area}' not found`);
      return;
    }

    // Remove existing widget with same id
    if (this.widgets.has(id)) {
      this.removeWidget(id);
    }

    this.widgets.set(id, widget);
    areaEl.appendChild(widget.getElement());
  }

  /**
   * Remove a widget
   */
  public removeWidget(id: string): void {
    const widget = this.widgets.get(id);
    if (widget) {
      widget.destroy();
      this.widgets.delete(id);
    }
  }

  /**
   * Get a widget by id
   */
  public getWidget(id: string): FPSHudWidget | undefined {
    return this.widgets.get(id);
  }

  // ===========================================================================
  // Core Widgets
  // ===========================================================================

  /**
   * Create the core HUD widgets (health, armor, ammo)
   */
  private createCoreWidgets(): void {
    // Combined Washoi manga vitals block - bottom left
    this.addWidget("vitals", new FPSVitalsBlock(), "bottom-left");

    // Weapon slots - bottom right (before ammo)
    this.addWidget("weaponslots", new FPSWeaponSlots(), "bottom-right");

    // Ammo counter - bottom right
    this.addWidget("ammo", new FPSAmmoCounter(), "bottom-right");

    // Ammo warning banner (OUT OF AMMO / RELOAD) - fixed above the speedometer
    this.addWidget("ammowarning", new FPSAmmoWarning(), "bottom-center");

    // Powerup countdown (QUAD) - bottom left, above the vitals block
    this.addWidget("powerup", new FPSPowerupTimer(), "bottom-left");

    // Air, while the head is under. Shares the powerup column because both are
    // transient states with a clock on them, and neither is ever the thing you
    // are looking at when it is absent.
    this.addWidget("air", new FPSAirMeter(), "bottom-left");

    // Bomb objective (S&D) — its own corner, not the timer cluster. Sharing
    // top-center put it hard against the frag counter, reading as one control.
    this.addWidget("bomb", new FPSBombStatus(), "top-left");

    // Match timer - top center
    this.addWidget("timer", new FPSTimer(), "top-center");

    // Frag counter - top center (next to timer)
    this.addWidget("frags", new FPSFragCounter(), "top-center");

    // Weapon rack - disabled, redundant with bottom-right weapon slots
    // this.addWidget("weapons", new FPSWeaponRack(), "left");

    // Round result banner (S&D) - center screen
    this.addWidget("roundresult", new FPSRoundResult(), "center");

    // Frag message - center screen
    this.addWidget("frag", new FPSFragMessage(), "center");

    // Pickup toast - bottom center
    this.addWidget("pickup", new FPSPickupToast(), "bottom-center");

    // Death screen - full overlay, managed via widget system
    this.addWidget("death", new FPSDeathScreen(), "center");

    // Match lifecycle widgets (replacing standalone MatchHUD)
    this.addWidget("phase", new FPSPhaseMessage(), "top-center");
    this.addWidget("ready", new FPSReadyBar(), "top-center");
    // Gametype badge joins the top-center scoreline (cyan tab right of timer)
    this.addWidget("gametype", new FPSGametypeBadge(), "top-center");
  }

  // ===========================================================================
  // Update Loop
  // ===========================================================================

  /**
   * Start the HUD update loop
   */
  public start(intervalMs: number = 50): void {
    if (this.running) return;
    this.running = true;
    this.updateInterval = window.setInterval(() => this.update(), intervalMs);
    console.log(`[FPSHud] Update loop started (${intervalMs}ms)`);
  }

  /**
   * Stop the HUD update loop
   */
  public stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    console.log("[FPSHud] Update loop stopped");
  }

  /**
   * Update all widgets with current HUDState
   */
  private update(): void {
    const state = HUDState.getInstance();
    for (const widget of this.widgets.values()) {
      widget.update(state);
    }

    // The chat log is not a widget, so it never sees the state tick — but it
    // needs the viewer's side to tell a teammate's name from an opponent's.
    this._chat?.setLocalTeam(state.scoreboard.find((e) => e.playerId === state.localPlayerId)?.teamId ?? "");

    // Keep the scoreboard live while open — it's a standalone overlay (not a
    // widget), and a one-shot refresh at open time can miss the final frag
    // whose score lands in the same snapshot as the phase change.
    if (this._scoreboard?.isVisible()) {
      this._scoreboard.refresh();
    }

    // Drive the on-weapon ammo counter with the same number the HUD shows
    // (clip for clip weapons). No-op for weapons without a counter.
    const a = state.ammo[state.currentWeapon];
    const clip = a && typeof a === "object" ? a.clip : typeof a === "number" ? a : 0;
    getWeaponViewManager().setAmmoCount(clip);
  }

  // ===========================================================================
  // Phase 3: Overlay Accessors
  // ===========================================================================

  /** Get the scoreboard overlay (Tab key toggle) */
  public get scoreboard(): FPSScoreboard | null {
    return this._scoreboard;
  }

  /** Get the chat overlay */
  public get chat(): FPSChat | null {
    return this._chat;
  }

  /** Get the pickup toast widget (bottom-center notifications). */
  public get pickupToast(): FPSPickupToast | undefined {
    return this.getWidget("pickup") as FPSPickupToast | undefined;
  }

  /** Get the damage indicators overlay */
  public get damageIndicators(): FPSDamageIndicators | null {
    return this._damageIndicators;
  }

  /** Get the pause menu dialog */
  public get pauseMenu(): FPSPauseMenu | null {
    return this._pauseMenu;
  }

  /** Get the settings overlay dialog */
  public get settings(): FPSSettingsOverlay | null {
    return this._settings;
  }

  // ===========================================================================
  // Visibility
  // ===========================================================================

  /**
   * Show the entire HUD
   */
  public show(): void {
    if (this.container) {
      this.container.style.display = "";
    }
  }

  /**
   * Hide the entire HUD
   */
  public hide(): void {
    if (this.container) {
      this.container.style.display = "none";
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Destroy the HUD system
   */
  public destroy(): void {
    this.stop();

    if (this._chatKeyHandler) {
      document.removeEventListener("keydown", this._chatKeyHandler, true);
      this._chatKeyHandler = null;
    }

    for (const widget of this.widgets.values()) {
      widget.destroy();
    }
    this.widgets.clear();
    this.areas.clear();

    // Destroy standalone overlays
    this._scoreboard?.destroy();
    this._scoreboard = null;
    this._chat?.destroy();
    this._chat = null;
    this._damageIndicators?.destroy();
    this._damageIndicators = null;

    // Destroy dialogs
    this._pauseMenu?.destroy();
    this._pauseMenu = null;
    this._settings?.destroy();
    this._settings = null;

    if (this.container) {
      this.container.remove();
      this.container = null;
    }

    UIStyles.removeCSS("washiki-theme");
    FPSHud.instance = null;
    console.log("[FPSHud] Destroyed");
  }
}
