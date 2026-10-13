export interface DemoOverlay {
  show(): void;
  hide(): void;
}

/**
 * Owns the visibility policy shared by the playback controls and replay chat:
 * `H` shows or hides them together. Overlay instances keep their own
 * lifecycle; this controller only decides whether they are visible.
 */
export class DemoOverlayController {
  private normalHud: DemoOverlay | null = null;
  private chat: DemoOverlay | null = null;
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

  setChat(overlay: DemoOverlay | null): void {
    this.chat = overlay;
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
    this.chat = null;
    this.visible = true;
  }

  private apply(): void {
    this.applyOverlay(this.normalHud, this.visible);
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
