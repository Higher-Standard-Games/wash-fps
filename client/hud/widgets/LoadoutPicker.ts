import {
  DEFAULT_LOADOUT,
  type LoadoutChoice,
  PRIMARY_CHOICES,
  type PrimaryWeapon,
  SECONDARY_CHOICES,
  type SecondaryWeapon,
  WEAPON_LABELS,
} from "../../../../../shared/server/gametype/Loadout";

// =============================================================================
// Loadout Picker — choose your kit before you spawn
// =============================================================================

/**
 * What each weapon is for, in one line.
 *
 * Written for someone who has never fired them. A picker that lists seven
 * weapon names and nothing else asks a new player to guess, and they will pick
 * whichever sounds best rather than whichever suits how they want to play.
 */
const WEAPON_BLURB: Record<PrimaryWeapon | SecondaryWeapon, string> = {
  rlauncher: "Splash damage. Forgiving, and it moves people.",
  voltaic: "Held beam. Steady damage, punishes anyone who stays close.",
  electrobolt: "Hitscan rail. All or nothing, at any range.",
  riotgun: "Close-range burst. Wins a corner.",
  plasmagun: "Fast bolts. Area denial and chip damage.",
  glauncher: "Bouncing splash. For doorways you cannot see through.",
  machinegun: "Reliable at range. Never the wrong answer.",
};

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
    this.element.style.display = "";
    this.render();
  }

  public close(): void {
    this.visible = false;
    this.onConfirm = null;
    this.element.style.display = "none";
  }

  public destroy(): void {
    this.element.remove();
  }

  private render(): void {
    this.element.textContent = "";

    const panel = document.createElement("div");
    panel.className = "fps-loadout-panel";

    const title = document.createElement("div");
    title.className = "fps-loadout-title";
    title.textContent = "CHOOSE YOUR LOADOUT";
    panel.appendChild(title);

    const note = document.createElement("div");
    note.className = "fps-loadout-note";
    note.textContent = "You always carry the blade. Everything else is on the map.";
    panel.appendChild(note);

    panel.appendChild(
      this.buildRow("PRIMARY", PRIMARY_CHOICES, this.primary, (id) => {
        this.primary = id as PrimaryWeapon;
        this.render();
      }),
    );
    panel.appendChild(
      this.buildRow("SECONDARY", SECONDARY_CHOICES, this.secondary, (id) => {
        this.secondary = id as SecondaryWeapon;
        this.render();
      }),
    );

    const confirm = document.createElement("button");
    confirm.className = "fps-loadout-confirm";
    confirm.textContent = "ENTER THE ROUND";
    confirm.onclick = () => {
      const choice: LoadoutChoice = { primary: this.primary, secondary: this.secondary };
      const callback = this.onConfirm;
      this.close();
      callback?.(choice);
    };
    panel.appendChild(confirm);

    this.element.appendChild(panel);
  }

  private buildRow(
    label: string,
    options: readonly string[],
    selected: string,
    onPick: (id: string) => void,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "fps-loadout-row";

    const heading = document.createElement("div");
    heading.className = "fps-loadout-row-label";
    heading.textContent = label;
    row.appendChild(heading);

    const options_ = document.createElement("div");
    options_.className = "fps-loadout-options";
    for (const id of options) {
      const key = id as PrimaryWeapon | SecondaryWeapon;
      const card = document.createElement("button");
      card.className = "fps-loadout-option";
      if (id === selected) card.classList.add("fps-loadout-option--selected");
      card.onclick = () => onPick(id);

      const name = document.createElement("div");
      name.className = "fps-loadout-option-name";
      name.textContent = WEAPON_LABELS[key];
      card.appendChild(name);

      const blurb = document.createElement("div");
      blurb.className = "fps-loadout-option-blurb";
      blurb.textContent = WEAPON_BLURB[key];
      card.appendChild(blurb);

      options_.appendChild(card);
    }
    row.appendChild(options_);

    return row;
  }
}
