import { CameraSystem } from "../../../../../engine/camera";
import { Cvar } from "../../../../../engine/core/Cvar";
import { InputSystem } from "../../../../../engine/input/InputSystem";
import { getWeaponViewManager } from "../../../../../engine/weapon/WeaponViewManager";
import { Game, type PlayerStateUpdate } from "../../../Game";
import { canonicalWeaponId, WEAPONS } from "../../../shared/entities/definitions/weapons/WeaponsTable";
import { FPS, getActionKeyLabel, getKeyLabel } from "../../FPSActions";
import { HUDState } from "../../HUDState";
import { MatchStateManager } from "../../MatchStateManager";
import { HINT_SHOW_MS, HintCoach, type HintId, type StatusSample } from "../HintCoach";
import type { FPSHudWidget } from "../HudWidget";

Cvar.register("cl_hints", 1, {
  type: "int",
  min: 0,
  max: 1,
  description: "Show hints for new players (movement, weapons, items), above your weapons",
});

/** Hints show all through warmup, and for this long into a live match (ms). */
const LIVE_HINT_MS = 2 * 60_000;
/** Aim progress that counts as aiming down sights. */
const AIMING = 0.8;

/** Keys listed per action: more make the line too long to read at a glance. */
const MAX_KEYS = 2;

/** The first keys bound to an action, as the player would name them. */
function keyLabels(action: string): string[] {
  const labels = InputSystem.getInstance()
    .getBindingsForAction(action)
    .map((binding) =>
      binding.key
        ? getKeyLabel(binding.key)
        : binding.mouseButton
          ? `MOUSE${{ left: 1, right: 2, middle: 3 }[binding.mouseButton] ?? ""}`
          : "",
    )
    .filter((label) => label !== "");
  return labels.length > 0 ? [...new Set(labels)].slice(0, MAX_KEYS) : [getActionKeyLabel(action)];
}

/** A hint's text, with the player's own keys for each action as key caps. */
function hintHtml(id: HintId): string {
  const key = (action: string) =>
    keyLabels(action)
      .map((label) => `<span class="fps-hint-key">${escapeHtml(label)}</span>`)
      .join(" or ");
  switch (id) {
    case "slide":
      return `When moving 400+ ups, hold ${key(FPS.CROUCH)} to crouchslide!`;
    case "aim":
      return `Hold ${key(FPS.AIM)} to aim!`;
    case "walljump":
      return `Press ${key(FPS.JUMP)} on a wall to walljump!`;
    case "bunnyhop":
      return `Hold ${key(FPS.MOVE_FORWARD)} and ${key(FPS.JUMP)} to bunny hop!`;
    case "slidespeed":
      return `At 400+ ups, hold ${key(FPS.CROUCH)} to crouchslide for a speed boost!`;
    case "fall":
      return `Hold ${key(FPS.CROUCH)} when falling to absorb damage!`;
    case "strafe":
      return `In the air, hold ${key(FPS.MOVE_LEFT)} or ${key(FPS.MOVE_RIGHT)} and turn the mouse to gain speed!`;
    case "ledge":
      return `Jump at a ledge holding ${key(FPS.MOVE_FORWARD)} to climb up; ${key(FPS.CROUCH)} lets go!`;
    case "health":
      return "Look for health items to recover!";
    case "armor":
      return "Find armor items for protection!";
    case "shock": {
      const weapon = WEAPONS[canonicalWeaponId(HUDState.getInstance().currentWeapon)]?.name ?? "this gun";
      return `Firing the ${escapeHtml(weapon)} underwater shocks you and everyone in the water!`;
    }
    case "air":
      return "Surface for air!";
    case "switch":
      return `Press ${[FPS.WEAPON_1, FPS.WEAPON_2, FPS.WEAPON_3].map((slot) => firstKey(slot)).join(", ")} or scroll to switch weapons!`;
    case "blade":
      return `With the blade, hold ${key(FPS.AIM)} to charge a blast!`;
    case "rocketjump":
      return `Press ${key(FPS.JUMP)} and fire ${key(FPS.FIRE)} at your feet to rocket jump!`;
    case "grenade":
      return "Grenades bounce: bank them around corners!";
    case "reload":
      return `Press ${key(FPS.RELOAD)} to reload before your clip runs dry!`;
    case "scoreboard":
      return `Hold ${key(FPS.SCOREBOARD)} to see the scores!`;
    case "plant":
      return "Stand still on flat ground at a bomb site to arm the bomb!";
    case "defuse":
      return "Stand by the planted bomb to defuse it!";
  }
}

/** The first key bound to an action, as a key cap. */
function firstKey(action: string): string {
  return `<span class="fps-hint-key">${escapeHtml(keyLabels(action)[0] ?? "?")}</span>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** Whether a weapon aims down sights: every gun with an ADS setup, not the blade. */
export function canAimWith(weaponId: string | null): boolean {
  if (!weaponId) return false;
  const id = canonicalWeaponId(weaponId);
  return id !== "blade" && !!WEAPONS[id]?.ads;
}

let active: FPSHintPanel | null = null;

/** The local player fired a weapon that can, or cannot, aim down sights: the aim hint may be due. */
export function noteLocalShotForHints(canAim: boolean): void {
  active?.shot(canAim);
}

/** The local player took fall damage: the hint to land crouched may be due. */
export function noteLocalFallForHints(): void {
  active?.fell();
}

/** The local player's clip ran dry with ammo in reserve: the reload hint may be due. */
export function noteEmptyClipForHints(): void {
  active?.clipEmptied();
}

/** The local player began charging a blast. */
export function noteLocalChargeForHints(): void {
  active?.charged();
}

/**
 * FPSHintPanel — a short tip for new players above the weapons, bottom
 * right: a "Hint" header and one line naming the player's own keys. HintCoach decides when;
 * the panel fades in, holds, and fades away. Off with cl_hints 0.
 */
export class FPSHintPanel implements FPSHudWidget {
  private readonly element: HTMLElement;
  private readonly text: HTMLElement;
  private readonly coach = new HintCoach();
  private hideTimer: number | null = null;
  /** Whether hints may show now, from the last HUD tick */
  private live = false;
  /** When the live match began, as this client saw it; null in warmup */
  private matchLiveSince: number | null = null;
  /** On the ground, from the last movement step */
  private grounded = true;
  private readonly unsubscribe: () => void;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-hint";
    const header = document.createElement("div");
    header.className = "fps-hint-header";
    header.textContent = "Hint";
    this.text = document.createElement("div");
    this.text.className = "fps-hint-text";
    this.element.append(header, this.text);
    active = this;
    // Every predicted movement step, not the HUD tick: a walljump chance
    // beside a wall lasts less than the tick
    this.unsubscribe = Game.getInstance().onPlayerStateUpdate((state) => this.moved(state));
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(state: HUDState): void {
    this.live = this.playing(state);
    if (!this.live) {
      this.dismiss();
      return;
    }
    // Fire held between shots: the controller knows, the shot events do not
    const controller = CameraSystem.getInstance().getController("fps") as { isFiring?(): boolean } | undefined;
    const view = getWeaponViewManager();
    const holding = controller?.isFiring?.() === true;
    const now = performance.now();
    const hint =
      this.coach.holdingFire(
        now,
        holding && view.getAdsProgress() < AIMING && canAimWith(view.getDisplayedWeaponId()),
      ) ?? this.coach.status(this.statusOf(state), now);
    if (hint) this.present(hint);
  }

  private statusOf(state: HUDState): StatusSample {
    const match = MatchStateManager.getInstance();
    const game = Game.getInstance();
    const weapon = canonicalWeaponId(state.currentWeapon);
    const me = state.scoreboard.find((entry) => entry.playerId === state.localPlayerId);
    const bomb = match.bomb;
    return {
      health: state.health,
      armor: state.armor,
      liveForMs: this.matchLiveSince === null ? null : performance.now() - this.matchLiveSince,
      weapon,
      carriesGun: state.weapons.some((id) => canonicalWeaponId(id) !== "blade"),
      grounded: this.grounded,
      waterLevel: game.localWaterLevel,
      air: game.localAirFraction,
      carriesBomb: !!bomb && !!me && bomb.carrier === me.entityId,
      defendingPlantedBomb:
        !!bomb && (bomb.phase === "planted" || bomb.phase === "armed") && !!me?.teamId && !match.isAttacking(me.teamId),
    };
  }

  private moved(state: PlayerStateUpdate): void {
    this.grounded = state.grounded;
    if (!this.live) return;
    const input = InputSystem.getInstance();
    const hint = this.coach.observe(
      {
        grounded: state.grounded,
        sliding: state.isSliding,
        horizontalSpeed: Math.hypot(state.velocity.x, state.velocity.z),
        verticalSpeed: state.velocity.y,
        wallJump: state.wallJumpState,
        ledgeGrab: state.ledgeGrabState,
        forward: input.isActive(FPS.MOVE_FORWARD),
        strafing: input.isActive(FPS.MOVE_LEFT) || input.isActive(FPS.MOVE_RIGHT),
      },
      performance.now(),
    );
    if (hint) this.present(hint);
  }

  /** The local player's clip ran dry with ammo in reserve. */
  public clipEmptied(): void {
    if (!this.playing(HUDState.getInstance())) return;
    const hint = this.coach.clipEmptied(performance.now());
    if (hint) this.present(hint);
  }

  /** The local player began charging a blast. */
  public charged(): void {
    this.coach.charged(performance.now());
  }

  /** Fall damage to the local player. */
  public fell(): void {
    if (!this.playing(HUDState.getInstance())) return;
    const hint = this.coach.fell(performance.now());
    if (hint) this.present(hint);
  }

  /** A shot from the local player, with whether its weapon can aim down sights. */
  public shot(canAim: boolean): void {
    if (!this.playing(HUDState.getInstance())) return;
    const fromHip = getWeaponViewManager().getAdsProgress() < AIMING;
    const hint = this.coach.shot(performance.now(), fromHip, canAim);
    if (hint) this.present(hint);
  }

  /**
   * Hints are for the player in play: not while dead, watching, or after the
   * match; all through warmup, and only the first minutes of the live match.
   */
  private playing(state: HUDState): boolean {
    const match = MatchStateManager.getInstance();
    const now = performance.now();
    if (match.isWarmup()) this.matchLiveSince = null;
    else if (match.isActive()) this.matchLiveSince ??= now;
    return (
      Cvar.getNumber("cl_hints") > 0 &&
      !state.localDead &&
      !state.watcher &&
      !match.isPostGame() &&
      (this.matchLiveSince === null || now - this.matchLiveSince < LIVE_HINT_MS)
    );
  }

  private present(id: HintId): void {
    this.text.innerHTML = hintHtml(id);
    this.element.classList.remove("fps-hint--shown");
    // Restart the fade-in for a hint replacing one still on screen
    void this.element.offsetWidth;
    this.element.classList.add("fps-hint--shown");
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.dismiss(), HINT_SHOW_MS);
  }

  private dismiss(): void {
    // Called on every tick while hints are off: touch the page only when one shows
    if (this.hideTimer === null) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.element.classList.remove("fps-hint--shown");
  }

  public show(): void {
    this.element.style.display = "";
  }

  public hide(): void {
    this.element.style.display = "none";
  }

  public destroy(): void {
    this.unsubscribe();
    this.dismiss();
    this.element.remove();
    if (active === this) active = null;
  }
}
