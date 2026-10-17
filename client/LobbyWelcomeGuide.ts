import { UIStyles } from "../../../engine/ui/UIStyles";
import { LobbyWelcomeDialog, welcomeIsHidden } from "./LobbyWelcomeDialog";
import { button } from "./settings/SettingsFields";
import welcomeCSS from "./styles/LobbyWelcomeDialog.css?raw";

/** Session state belongs to this client boot, not a lobby connection or account. */
export interface WelcomeBootState {
  initialReady: boolean;
  completed: boolean;
}
export const welcomeBootState: WelcomeBootState = { initialReady: false, completed: false };

export class LobbyWelcomeGuide {
  readonly help = button("lobby-guide-help", "?");
  private readonly back = button("lobby-guide-back", "« Back to welcome");
  private dialog: LobbyWelcomeDialog | null = null;
  private authenticated = false;
  private visible = false;
  private manual = false;
  private tab = 0;
  private readonly secondaryTip = Math.random() < 0.5 ? 0 : 1;
  private disposed = false;
  suspended = false;

  constructor(
    private readonly host: {
      root: HTMLElement;
      helpParent?: HTMLElement;
      showHelp?(): boolean;
      canOpen(): boolean;
      prepareOpen(): void;
      openControls(back: HTMLButtonElement): void;
      finished(): void;
    },
    private readonly state = welcomeBootState,
  ) {
    UIStyles.injectCSS("lobby-guide", welcomeCSS);
    this.help.setAttribute("aria-label", "Welcome & tips");
    this.help.title = "Welcome & tips";
    this.help.hidden = true;
    this.help.addEventListener("click", () => {
      if (!this.visible || !this.authenticated || !host.canOpen() || host.showHelp?.() === false || this.dialog) return;
      this.suspended = false;
      this.back.remove();
      this.manual = true;
      this.tab = 0;
      this.refresh();
    });
    this.back.addEventListener("click", () => this.resume());
    (host.helpParent ?? host.root).append(this.help);
  }
  get readyForJoin(): boolean {
    return this.state.initialReady && this.state.completed && !this.dialog && !this.suspended;
  }
  initialLoadingDismissed(): void {
    this.state.initialReady = true;
    this.refresh();
  }
  setAuthenticated(value: boolean): void {
    this.authenticated = value;
    this.refresh();
  }
  show(): void {
    this.visible = true;
    this.refresh();
  }
  private unmount(restoreFocus = false): void {
    this.dialog?.destroy(restoreFocus);
    this.dialog = null;
  }
  refresh(): void {
    if (this.disposed) return;
    const allowed = this.visible && this.authenticated && this.host.canOpen();
    this.help.hidden = !allowed || this.host.showHelp?.() === false;
    if (!allowed) {
      this.unmount();
      return;
    }
    if (this.suspended || !this.state.initialReady || (!this.manual && this.state.completed)) return;
    if (!this.manual && welcomeIsHidden()) {
      this.state.completed = true;
      this.host.finished();
      return;
    }
    if (this.dialog) return;
    this.host.prepareOpen();
    this.dialog = new LobbyWelcomeDialog({
      background: this.host.root,
      tab: this.tab,
      secondaryTip: this.secondaryTip,
      onTab: (tab) => {
        this.tab = tab;
      },
      onClose: () => {
        this.state.completed = true;
        this.manual = false;
        this.tab = 0;
        this.unmount(true);
        if (!this.help.hidden) this.help.focus();
        this.host.finished();
      },
      onSetup: () => {
        this.suspended = true;
        this.tab = 1;
        this.unmount();
        this.host.openControls(this.back);
      },
    });
  }
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.back.remove();
    this.refresh();
  }
  leaveLobby(): void {
    this.visible = false;
    if (this.state.initialReady) this.state.completed = true;
    this.manual = false;
    this.suspended = false;
    this.back.remove();
    this.unmount();
    this.help.hidden = true;
  }
  destroy(): void {
    this.disposed = true;
    this.unmount();
    this.help.remove();
    this.back.remove();
  }
}
