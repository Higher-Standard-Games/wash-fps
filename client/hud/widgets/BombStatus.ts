import { MatchStateManager } from "../../MatchStateManager";
import type { FPSHudWidget, HUDState } from "../HudWidget";

// =============================================================================
// Bomb Status — the Search & Destroy objective, top-centre under the timer
// =============================================================================

/** Below this the fuse display goes urgent. Matches the beep's own acceleration. */
const URGENT_SECONDS = 10;

/**
 * What the bomb's current phase means to the player, per side.
 *
 * Split by role because the same world state is opposite news: "bomb armed" is
 * a countdown to victory for one team and a countdown to defeat for the other,
 * and a HUD that says the same thing to both is telling one of them nothing.
 */
const PHASE_TEXT: Record<string, { attacker: string; defender: string }> = {
  dropped: { attacker: "TAKE THE BOMB", defender: "BOMB LOOSE" },
  carried: { attacker: "PLANT THE BOMB", defender: "BOMB CARRIED" },
  planted: { attacker: "ARMING", defender: "STOP THE ARM" },
  armed: { attacker: "BOMB ARMED", defender: "DEFUSE" },
  defused: { attacker: "DEFUSED", defender: "DEFUSED" },
  detonated: { attacker: "DETONATED", defender: "DETONATED" },
};

/**
 * FPSBombStatus — the bomb's phase, its fuse, and the shared arm/defuse meter.
 *
 * Reads `MatchStateManager.bomb`, which is fed straight from the server's
 * objective snapshot, so the widget cannot show a state the server does not
 * believe in. It renders nothing at all in modes without a bomb.
 *
 * The progress bar is the part worth getting right. Arm and defuse progress is
 * shared and decaying rather than per-player (see `ProgressMeter`), so a bar
 * that is FALLING is real information — it tells a defender how long they have
 * before the attackers' work is undone, and tells an attacker that nobody is
 * on the bomb. The bar changes colour rather than just shrinking.
 */
export class FPSBombStatus implements FPSHudWidget {
  private element: HTMLElement;
  private phaseLabel: HTMLElement;
  private fuseLabel: HTMLElement;
  private meter: HTMLElement;
  private meterFill: HTMLElement;
  /** Last rendered signature, so identical frames skip the DOM entirely. */
  private rendered: string | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-bomb-status";
    this.element.style.display = "none";

    this.phaseLabel = document.createElement("div");
    this.phaseLabel.className = "fps-bomb-status-phase";
    this.element.appendChild(this.phaseLabel);

    this.fuseLabel = document.createElement("div");
    this.fuseLabel.className = "fps-bomb-status-fuse";
    this.element.appendChild(this.fuseLabel);

    this.meter = document.createElement("div");
    this.meter.className = "fps-bomb-status-meter";
    this.meterFill = document.createElement("div");
    this.meterFill.className = "fps-bomb-status-meter-fill";
    this.meter.appendChild(this.meterFill);
    this.element.appendChild(this.meter);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(state: HUDState): void {
    const match = MatchStateManager.getInstance();
    const bomb = match.bomb;

    if (!bomb) {
      this.clear();
      return;
    }

    // The local player's team, from the scoreboard the HUD already builds —
    // there is no top-level local team on HUDState.
    const localTeam = state.scoreboard.find((entry) => entry.playerId === state.localPlayerId)?.teamId;
    const attacking = match.isAttacking(localTeam);
    const text = PHASE_TEXT[bomb.phase];
    if (!text) {
      this.clear();
      return;
    }

    // Tenths, not raw seconds: a fuse that only moves once a second reads as
    // frozen at the moment it matters most.
    const fuse = bomb.fuse === null ? null : Math.max(0, bomb.fuse);
    const fuseText = fuse === null ? "" : fuse.toFixed(1);
    const urgent = fuse !== null && fuse <= URGENT_SECONDS;
    const progress = Math.round(bomb.progress * 100);

    const signature = `${bomb.phase}|${attacking}|${fuseText}|${progress}|${bomb.advancing}`;
    if (signature === this.rendered) return;
    this.rendered = signature;

    this.phaseLabel.textContent = attacking ? text.attacker : text.defender;
    this.fuseLabel.textContent = fuseText;
    this.fuseLabel.style.display = fuse === null ? "none" : "";

    this.element.classList.toggle("fps-bomb-status--urgent", urgent);
    this.element.classList.toggle("fps-bomb-status--armed", bomb.phase === "armed");

    // A meter at zero is not "nothing happening" worth drawing — hide it, so
    // the bar appearing is itself the signal that somebody is on the bomb.
    this.meter.style.display = progress > 0 ? "" : "none";
    this.meterFill.style.width = `${progress}%`;
    this.meterFill.classList.toggle("fps-bomb-status-meter-fill--decaying", !bomb.advancing);

    this.element.style.display = "";
  }

  private clear(): void {
    if (this.rendered === null) return;
    this.rendered = null;
    this.element.style.display = "none";
  }

  public show(): void {
    // Visibility is state-driven via update(); nothing to force here.
  }

  public hide(): void {
    this.element.style.display = "none";
  }

  public destroy(): void {
    this.element.remove();
  }
}
