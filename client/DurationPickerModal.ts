/**
 * DurationPickerModal — Small modal for choosing highlight reel duration
 *
 * Usage:
 *   DurationPickerModal.show((minutes) => { ... });
 *
 * Renders a centered overlay with 1 / 2 / 5 minute options and a PLAY button.
 * Matches the lobby's dark translucent aesthetic.
 */

export class DurationPickerModal {
  private static _active: DurationPickerModal | null = null;

  private overlay: HTMLDivElement;
  private onConfirm: (minutes: number) => void;
  private selected: number = 2;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  private constructor(onConfirm: (minutes: number) => void) {
    this.onConfirm = onConfirm;
    this.overlay = this._build();
  }

  // ── Static entry point ────────────────────────────────────────────────────

  /**
   * Show the modal.  If one is already open it is closed first.
   * @param onConfirm called with the chosen duration in minutes when Play is clicked
   */
  static show(onConfirm: (minutes: number) => void): void {
    DurationPickerModal._active?.dispose();
    const modal = new DurationPickerModal(onConfirm);
    DurationPickerModal._active = modal;
    document.body.appendChild(modal.overlay);
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  private _build(): HTMLDivElement {
    // Backdrop
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 20000;
      background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      font-family: var(--w-font-display, 'Orbitron', 'Inter', sans-serif);
    `;

    // Dismiss on backdrop click
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.dispose();
    });

    // Panel
    const panel = document.createElement("div");
    panel.style.cssText = `
      background: rgba(12,14,20,0.97);
      border: 1px solid rgba(255,180,60,0.25);
      border-radius: 8px;
      padding: 28px 32px;
      min-width: 280px;
      text-align: center;
      box-shadow: 0 0 40px rgba(0,0,0,0.8);
    `;
    overlay.appendChild(panel);

    // Title
    const title = document.createElement("div");
    title.textContent = "⚡ HIGHLIGHT REEL";
    title.style.cssText = `
      color: rgba(255,180,60,0.95); font-size: 13px; font-weight: 700;
      letter-spacing: 0.15em; margin-bottom: 20px;
    `;
    panel.appendChild(title);

    // Duration label
    const label = document.createElement("div");
    label.textContent = "Duration:";
    label.style.cssText = `
      color: rgba(255,255,255,0.4); font-size: 11px; letter-spacing: 0.1em;
      margin-bottom: 12px;
    `;
    panel.appendChild(label);

    // Duration buttons row
    const btnRow = document.createElement("div");
    btnRow.style.cssText = `
      display: flex; gap: 8px; justify-content: center; margin-bottom: 24px;
    `;
    panel.appendChild(btnRow);

    const durationOptions = [1, 2, 5];
    const durationBtns: HTMLButtonElement[] = [];

    for (const min of durationOptions) {
      const btn = document.createElement("button");
      btn.textContent = `${min} min`;
      btn.dataset["min"] = String(min);
      btn.style.cssText = `
        padding: 8px 18px; border-radius: 4px; cursor: pointer;
        font-family: inherit; font-size: 12px; font-weight: 700;
        letter-spacing: 0.08em; transition: background 0.15s, border-color 0.15s;
        border: 1px solid rgba(255,180,60,0.3);
        background: rgba(255,180,60,0.08); color: rgba(255,180,60,0.75);
      `;
      btn.addEventListener("click", () => {
        this.selected = min;
        this._updateSelection(durationBtns, min);
      });
      durationBtns.push(btn);
      btnRow.appendChild(btn);
    }

    // Set initial selection
    this._updateSelection(durationBtns, this.selected);

    // Play button
    const playBtn = document.createElement("button");
    playBtn.textContent = "▶  PLAY HIGHLIGHTS";
    playBtn.style.cssText = `
      display: block; width: 100%; padding: 11px;
      background: rgba(255,180,60,0.18); border: 1px solid rgba(255,180,60,0.5);
      color: rgba(255,180,60,0.95); font-family: inherit;
      font-size: 12px; font-weight: 700; letter-spacing: 0.12em;
      cursor: pointer; border-radius: 4px; margin-bottom: 8px;
      transition: background 0.15s;
    `;
    playBtn.addEventListener("mouseover", () => {
      playBtn.style.background = "rgba(255,180,60,0.32)";
    });
    playBtn.addEventListener("mouseout", () => {
      playBtn.style.background = "rgba(255,180,60,0.18)";
    });
    playBtn.addEventListener("click", () => {
      const minutes = this.selected;
      this.dispose();
      this.onConfirm(minutes);
    });
    panel.appendChild(playBtn);

    // Cancel button
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "CANCEL";
    cancelBtn.style.cssText = `
      display: block; width: 100%; padding: 9px;
      background: transparent; border: 1px solid rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.35); font-family: inherit;
      font-size: 11px; font-weight: 700; letter-spacing: 0.1em;
      cursor: pointer; border-radius: 4px; transition: background 0.15s;
    `;
    cancelBtn.addEventListener("click", () => this.dispose());
    panel.appendChild(cancelBtn);

    // Keyboard ESC — stored on instance so dispose() can remove it
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.dispose();
      }
    };
    document.addEventListener("keydown", this.keyHandler);

    return overlay;
  }

  private _updateSelection(buttons: HTMLButtonElement[], selected: number): void {
    for (const btn of buttons) {
      const isSelected = Number(btn.dataset["min"]) === selected;
      btn.style.background = isSelected
        ? "rgba(255,180,60,0.35)"
        : "rgba(255,180,60,0.08)";
      btn.style.borderColor = isSelected
        ? "rgba(255,180,60,0.8)"
        : "rgba(255,180,60,0.3)";
      btn.style.color = isSelected
        ? "rgba(255,210,80,1)"
        : "rgba(255,180,60,0.75)";
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose(): void {
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    this.overlay.remove();
    if (DurationPickerModal._active === this) {
      DurationPickerModal._active = null;
    }
  }
}
