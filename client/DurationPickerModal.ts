/**
 * DurationPickerModal — Small modal for choosing highlight reel duration
 *
 * Usage:
 *   DurationPickerModal.show((minutes) => { ... });
 *
 * Renders a centered overlay with 1 / 2 / 5 minute options and a PLAY button.
 * Matches the lobby's dark translucent aesthetic.
 */

import { UIStyles } from "../../../engine/ui/UIStyles";
import cssRaw from "./styles/DurationPickerModal.css?raw";

// Inject CSS once on first import
UIStyles.injectCSS("duration-picker-modal", cssRaw);

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
    overlay.className = "duration-picker-overlay";

    // Dismiss on backdrop click
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.dispose();
    });

    // Panel
    const panel = document.createElement("div");
    panel.className = "duration-picker-panel";
    overlay.appendChild(panel);

    // Title
    const title = document.createElement("div");
    title.textContent = "⚡ HIGHLIGHT REEL";
    title.className = "duration-picker-title";
    panel.appendChild(title);

    // Duration label
    const label = document.createElement("div");
    label.textContent = "Duration:";
    label.className = "duration-picker-label";
    panel.appendChild(label);

    // Duration buttons row
    const btnRow = document.createElement("div");
    btnRow.className = "duration-picker-options";
    panel.appendChild(btnRow);

    const durationOptions = [1, 2, 5];
    const durationBtns: HTMLButtonElement[] = [];

    for (const min of durationOptions) {
      const btn = document.createElement("button");
      btn.textContent = `${min} min`;
      btn.dataset["min"] = String(min);
      btn.className = "duration-picker-option";
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
    playBtn.className = "duration-picker-play";
    playBtn.addEventListener("click", () => {
      const minutes = this.selected;
      this.dispose();
      this.onConfirm(minutes);
    });
    panel.appendChild(playBtn);

    // Cancel button
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "CANCEL";
    cancelBtn.className = "duration-picker-cancel";
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
      if (isSelected) {
        btn.classList.add("duration-picker-option--selected");
      } else {
        btn.classList.remove("duration-picker-option--selected");
      }
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
