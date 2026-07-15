export interface DemoOverlay {
  show(): void;
  hide(): void;
}

export type DemoOverlayMode = "normal" | "cinematic";

/**
 * Owns the visibility policy shared by normal demo transport, cinematic
 * presentation, and replay chat. Overlay instances keep their own lifecycle;
 * this controller only decides which of them is visible.
 */
export class DemoOverlayController {
  private normalHud: DemoOverlay | null = null;
  private cinematicHud: DemoOverlay | null = null;
  private chat: DemoOverlay | null = null;
  private mode: DemoOverlayMode = "normal";
  private visible = true;
  private keyTarget: Document | null = null;
  private readonly keyHandler = (event: KeyboardEvent): void => {
    if (
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.code !== "KeyH" ||
      DemoOverlayController.isTextEntry(event.target)
    ) {
      return;
    }
    event.preventDefault();
    this.toggle();
  };

  setNormalHud(overlay: DemoOverlay | null): void {
    this.normalHud = overlay;
    this.apply();
  }

  setCinematicHud(overlay: DemoOverlay | null): void {
    this.cinematicHud = overlay;
    this.apply();
  }

  setChat(overlay: DemoOverlay | null): void {
    this.chat = overlay;
    this.apply();
  }

  setMode(mode: DemoOverlayMode): void {
    this.mode = mode;
    this.apply();
  }

  setVisible(visible: boolean): boolean {
    this.visible = visible;
    this.apply();
    return this.visible;
  }

  toggle(): boolean {
    return this.setVisible(!this.visible);
  }

  isVisible(): boolean {
    return this.visible;
  }

  bindKeyboard(target: Document = document): void {
    if (this.keyTarget === target) return;
    this.unbindKeyboard();
    this.keyTarget = target;
    target.addEventListener("keydown", this.keyHandler, true);
  }

  unbindKeyboard(): void {
    this.keyTarget?.removeEventListener("keydown", this.keyHandler, true);
    this.keyTarget = null;
  }

  reset(): void {
    this.unbindKeyboard();
    this.normalHud = null;
    this.cinematicHud = null;
    this.chat = null;
    this.mode = "normal";
    this.visible = true;
  }

  private apply(): void {
    this.applyOverlay(this.normalHud, this.visible && this.mode === "normal");
    this.applyOverlay(this.cinematicHud, this.visible && this.mode === "cinematic");
    this.applyOverlay(this.chat, this.visible);
  }

  private applyOverlay(overlay: DemoOverlay | null, visible: boolean): void {
    if (!overlay) return;
    if (visible) overlay.show();
    else overlay.hide();
  }

  private static isTextEntry(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) return false;
    const tag = element.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || element.isContentEditable;
  }
}
