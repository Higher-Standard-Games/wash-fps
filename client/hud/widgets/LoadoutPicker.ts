import { WEAPONS } from "../../../../../shared/entities/definitions/weapons/WeaponsTable";
import {
  DEFAULT_LOADOUT,
  type LoadoutChoice,
  PRIMARY_CHOICES,
  type PrimaryWeapon,
  SECONDARY_CHOICES,
  type SecondaryWeapon,
  WEAPON_LABELS,
} from "../../../../../shared/server/gametype/Loadout";
import { WeaponPreview } from "./WeaponPreview";

// =============================================================================
// Loadout Picker — choose your kit before you spawn
// =============================================================================

/**
 * FPSLoadoutPicker — the kit dialog, shown before a player enters the game.
 *
 * Deliberately blocking: in Search & Destroy your kit decides what you can do
 * for a whole round with no respawn to correct it, so being dropped into a
 * round holding a default nobody chose is worse than a moment spent choosing.
 *
 * Not a HUD widget. It is a full-screen overlay with pointer events, managed by
 * whoever opens it, because a widget that swallows the mouse would break every
 * other widget on the frames it is up.
 */
export class FPSLoadoutPicker {
  private element: HTMLElement;
  private primary: PrimaryWeapon = DEFAULT_LOADOUT.primary;
  private secondary: SecondaryWeapon = DEFAULT_LOADOUT.secondary;
  private onConfirm: ((choice: LoadoutChoice) => void) | null = null;
  private visible = false;
  /** Weapon on the stand. Follows hover, falls back to the chosen primary. */
  private focus: PrimaryWeapon | SecondaryWeapon = DEFAULT_LOADOUT.primary;
  /** Built on first open — a WebGL context is too expensive to hold unused. */
  private preview: WeaponPreview | null = null;
  /** Last path handed to the stand, so re-rendering does not reload the model. */
  private lastPreviewed: string | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-loadout";
    this.element.style.display = "none";
    this.render();
    // Straight onto the body, like the scoreboard: a full-screen overlay that
    // takes the mouse cannot live inside the HUD container it would cover.
    document.body.appendChild(this.element);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public get isOpen(): boolean {
    return this.visible;
  }

  /**
   * Open the picker. `current` pre-selects what the player already has, so
   * reopening it mid-match is a review rather than a fresh decision.
   */
  public open(onConfirm: (choice: LoadoutChoice) => void, current?: LoadoutChoice): void {
    if (current) {
      this.primary = current.primary;
      this.secondary = current.secondary;
    }
    this.onConfirm = onConfirm;
    this.visible = true;
    this.focus = this.primary;
    this.lastPreviewed = null;
    this.element.style.display = "";
    this.render();
  }

  public close(): void {
    this.visible = false;
    this.onConfirm = null;
    this.element.style.display = "none";
    // Give the WebGL context back. The picker is open for seconds at a time and
    // a held context is one the game cannot have.
    this.preview?.dispose();
    this.preview = null;
    this.lastPreviewed = null;
  }

  public destroy(): void {
    this.preview?.dispose();
    this.preview = null;
    this.element.remove();
  }

  private render(): void {
    this.element.textContent = "";

    const panel = document.createElement("div");
    panel.className = "fps-loadout-panel";

    const hero = document.createElement("div");
    hero.className = "fps-loadout-hero";
    hero.innerHTML = `
      <div class="fps-loadout-kicker">Search &amp; Destroy</div>
      <div class="fps-loadout-heading">Loadout</div>
      <div class="fps-loadout-subtitle">You always carry the blade. Everything else is on the map.</div>
    `;
    panel.appendChild(hero);

    const body = document.createElement("div");
    body.className = "fps-loadout-body";

    const columns = document.createElement("div");
    columns.className = "fps-loadout-columns";
    columns.appendChild(
      this.buildColumn("Primary", PRIMARY_CHOICES, this.primary, (id) => {
        this.primary = id as PrimaryWeapon;
        this.lastPreviewed = null;
        this.render();
      }),
    );
    columns.appendChild(
      this.buildColumn("Secondary", SECONDARY_CHOICES, this.secondary, (id) => {
        this.secondary = id as SecondaryWeapon;
        this.lastPreviewed = null;
        this.render();
      }),
    );
    body.appendChild(columns);
    body.appendChild(this.buildPreview());
    panel.appendChild(body);

    const confirm = document.createElement("button");
    confirm.className = "fps-loadout-confirm";
    confirm.innerHTML = `<span>Enter the round</span>`;
    confirm.onclick = () => {
      const choice: LoadoutChoice = { primary: this.primary, secondary: this.secondary };
      const callback = this.onConfirm;
      this.close();
      callback?.(choice);
    };
    panel.appendChild(confirm);

    this.element.appendChild(panel);
  }

  /**
   * The stand. One weapon at a time, so the cost does not scale with how many
   * weapons the mode offers — and the picture is of the model that will
   * actually be in your hands, not a drawing of it that can go stale.
   */
  private buildPreview(): HTMLElement {
    const stage = document.createElement("div");
    stage.className = "fps-loadout-preview";

    this.preview ??= new WeaponPreview();
    stage.appendChild(this.preview.canvas);

    const caption = document.createElement("div");
    caption.className = "fps-loadout-preview-name";
    caption.textContent = WEAPON_LABELS[this.focus];
    stage.appendChild(caption);

    const modelPath = WEAPONS[this.focus]?.modelPath;
    if (modelPath && this.lastPreviewed !== modelPath) {
      this.lastPreviewed = modelPath;
      void this.preview.show(modelPath);
    }
    // The canvas has no layout until it is in the document.
    requestAnimationFrame(() => this.preview?.resize());

    return stage;
  }

  private buildColumn(
    label: string,
    options: readonly string[],
    selected: string,
    onPick: (id: string) => void,
  ): HTMLElement {
    const column = document.createElement("div");
    column.className = "fps-loadout-column";

    const heading = document.createElement("div");
    heading.className = "fps-loadout-column-label";
    heading.textContent = label;
    column.appendChild(heading);

    for (const id of options) {
      const key = id as PrimaryWeapon | SecondaryWeapon;
      const card = document.createElement("button");
      card.className = "fps-loadout-option";
      if (id === selected) card.classList.add("fps-loadout-option--selected");
      card.textContent = WEAPON_LABELS[key];
      card.onclick = () => onPick(id);
      // Hovering previews without committing, so the stand can be browsed.
      card.onmouseenter = () => this.setFocus(key);
      column.appendChild(card);
    }

    return column;
  }

  /** Point the stand at `weapon` without changing the chosen kit. */
  private setFocus(weapon: PrimaryWeapon | SecondaryWeapon): void {
    if (this.focus === weapon) return;
    this.focus = weapon;
    this.render();
  }
}
