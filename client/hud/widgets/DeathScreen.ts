// Extracted from FPSHud.ts
import { FPS, getActionKeyLabel } from "../../FPSActions";
import type { KillFeedEntry } from "../../HUDState";
import { MatchStateManager } from "../../MatchStateManager";
import type { FPSHudWidget, HUDState } from "../HudWidget";

// Respawn protection delay in seconds (must match server config)
const RESPAWN_DELAY_SECS = 3;

/** How close to the panel's own moment a kill feed entry must be to be this death */
const DEATH_MATCH_WINDOW_MS = 1500;

/**
 * How you died, in the card's words. The death event carries the server's
 * damage type, not a weapon, so that is what the wording follows.
 */
const KILLED_BY: Record<string, string> = {
  explosion: "Blown up by",
  rail: "Railed by",
  plasma: "Melted by",
  bullet: "Gunned down by",
  melee: "Cut down by",
  telefrag: "Telefragged by",
  fall_crush: "Crushed by",
};

/** A death nobody else caused: what the card names instead of a killer */
function noKiller(damageType: string): string {
  switch (damageType) {
    case "fall":
    case "fall_crush":
      return "The fall";
    case "world":
      return "The map";
    case "explosion":
      return "Your own blast";
    default:
      return "Yourself";
  }
}

/** The kicker and the name the card shows for a death */
export function obituary(entry: KillFeedEntry): { how: string; who: string } {
  const damageType = entry.weaponId.toLowerCase();
  if (!entry.killerName || entry.killerId === entry.victimId) {
    return { how: "No one to blame", who: noKiller(damageType) };
  }
  return { how: KILLED_BY[damageType] ?? "Fragged by", who: entry.killerName };
}

// =============================================================================
// Death Screen — "YOU GOT FRAGGED"
// =============================================================================

/**
 * FPSDeathScreen - Shows when player dies
 *
 * The red stamp, then a card: who fragged you and how, and the way back — a
 * countdown for respawn protection with a bar, then the key that respawns
 * you, or in a round mode, that you are out until the next round.
 */
export class FPSDeathScreen implements FPSHudWidget {
  private element: HTMLElement;
  private cardEl: HTMLElement;
  private howEl: HTMLElement;
  private whoEl: HTMLElement;
  private nextLabelEl: HTMLElement;
  private timerEl: HTMLElement;
  private respawnEl: HTMLElement;
  private barEl: HTMLElement;
  private fillEl: HTMLElement;
  private wasAlive: boolean = true;
  /** This death has already had its panel; do not stage it a second time. */
  private shownForThisDeath: boolean = false;
  /** The kill feed has named this death; until it does, keep looking */
  private named: boolean = false;
  private deathTime: number = 0;
  private countdownInterval: number | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-death-screen";
    this.element.style.display = "none";

    const panel = document.createElement("div");
    panel.className = "fps-death-panel";

    const title = document.createElement("div");
    title.className = "fps-death-title";
    title.textContent = "YOU GOT FRAGGED";
    panel.appendChild(title);

    this.cardEl = document.createElement("div");
    this.cardEl.className = "fps-death-card";

    const who = document.createElement("div");
    who.className = "fps-death-who";
    this.howEl = document.createElement("div");
    this.howEl.className = "fps-death-how";
    this.whoEl = document.createElement("div");
    this.whoEl.className = "fps-death-killer";
    who.append(this.howEl, this.whoEl);

    const next = document.createElement("div");
    next.className = "fps-death-next";
    this.nextLabelEl = document.createElement("div");
    this.nextLabelEl.className = "fps-death-next-label";
    this.timerEl = document.createElement("div");
    this.timerEl.className = "fps-death-timer";
    this.respawnEl = document.createElement("div");
    this.respawnEl.className = "fps-death-respawn";
    next.append(this.nextLabelEl, this.timerEl, this.respawnEl);

    this.barEl = document.createElement("div");
    this.barEl.className = "fps-death-bar";
    this.fillEl = document.createElement("div");
    this.fillEl.className = "fps-death-fill";
    this.barEl.appendChild(this.fillEl);

    this.cardEl.append(who, next, this.barEl);
    panel.appendChild(this.cardEl);
    this.element.appendChild(panel);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * The panel belongs to the MOMENT of death, and gets it once.
   *
   * The order in a round mode is: you go down, the camera holds on your body
   * and this says what happened, and then a couple of seconds later the camera
   * moves to a living teammate and this gets out of the way — you are watching
   * their fight now, not reading about your own.
   *
   * `shownForThisDeath` is what stops it coming back. Handing the screen over
   * to a teammate is not being alive again, so the hide must not re-arm the
   * show; without it the panel reappeared the moment spectating ended, and
   * announced "YOU GOT FRAGGED" over the round-end camera for a death that
   * happened a minute earlier.
   */
  public update(state: HUDState): void {
    if (!state.localDead) {
      if (!this.wasAlive) {
        // Respawned — hide death screen
        this.wasAlive = true;
        this.stopCountdown();
        this.element.style.display = "none";
      }
      this.shownForThisDeath = false;
      return;
    }

    // Dead, and the camera has moved on to a teammate. Their fight owns the
    // screen; ours is over.
    if (state.spectating !== "") {
      if (!this.wasAlive) {
        this.stopCountdown();
        this.element.style.display = "none";
      }
      return;
    }

    if (this.shownForThisDeath) {
      // The death event and the dead flag travel separately, so the entry
      // naming this death can land a frame or two after the panel went up
      if (!this.named) this.nameKiller(state.killFeed);
      return;
    }
    this.shownForThisDeath = true;
    this.wasAlive = false;
    this.deathTime = performance.now();

    this.named = false;
    this.howEl.textContent = "";
    this.whoEl.textContent = "";
    this.cardEl.classList.remove("fps-death-card--named");
    this.nameKiller(state.killFeed);

    this.respawnEl.replaceChildren();
    this.respawnEl.style.display = "none";
    this.startCountdown();

    this.element.style.display = "";
  }

  /** The newest kill feed entry for our death, if it is this one */
  private nameKiller(feed: readonly KillFeedEntry[]): void {
    for (let index = feed.length - 1; index >= 0; index--) {
      const entry = feed[index];
      if (!entry.ofLocal) continue;
      if (entry.timestamp < this.deathTime - DEATH_MATCH_WINDOW_MS) return;
      const { how, who } = obituary(entry);
      this.howEl.textContent = how;
      this.whoEl.textContent = who;
      this.cardEl.classList.add("fps-death-card--named");
      this.named = true;
      return;
    }
  }

  private startCountdown(): void {
    this.stopCountdown();
    this.updateTimer();
    this.countdownInterval = window.setInterval(() => this.updateTimer(), 50);
  }

  private stopCountdown(): void {
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  private updateTimer(): void {
    // Round modes have no respawn: you are out until the round turns over, so
    // a countdown to a button that does nothing is worse than no countdown.
    // Say what is actually happening instead.
    if (MatchStateManager.getInstance().round > 0) {
      this.cardEl.dataset.next = "round";
      this.nextLabelEl.textContent = "Out this round";
      this.timerEl.style.display = "none";
      this.respawnEl.textContent = "WAITING FOR THE NEXT ROUND";
      this.respawnEl.style.display = "";
      this.stopCountdown();
      return;
    }

    const elapsed = (performance.now() - this.deathTime) / 1000;
    const remaining = Math.max(0, RESPAWN_DELAY_SECS - elapsed);
    this.fillEl.style.width = `${Math.min(100, (elapsed / RESPAWN_DELAY_SECS) * 100)}%`;

    if (remaining > 0) {
      this.cardEl.dataset.next = "countdown";
      this.nextLabelEl.textContent = "Respawn in";
      this.timerEl.textContent = remaining.toFixed(1);
      this.timerEl.style.display = "";
      this.respawnEl.style.display = "none";
    } else {
      this.cardEl.dataset.next = "ready";
      this.nextLabelEl.textContent = "Ready";
      this.timerEl.style.display = "none";
      // "PRESS [MOUSE1] TO RESPAWN" — the fire keybind rendered as a keycap.
      const keycap = document.createElement("span");
      keycap.className = "fps-keycap";
      keycap.textContent = getActionKeyLabel(FPS.FIRE);
      this.respawnEl.replaceChildren("PRESS ", keycap, " TO RESPAWN");
      this.respawnEl.style.display = "";
      this.stopCountdown();
    }
  }

  public show(): void {
    this.element.style.display = "";
  }

  public hide(): void {
    this.element.style.display = "none";
  }

  public destroy(): void {
    this.stopCountdown();
    this.element.remove();
  }
}
