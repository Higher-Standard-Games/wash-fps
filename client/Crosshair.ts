/**
 * Crosshair — Dynamic canvas-drawn crosshair with ADS spread and damage flash
 *
 * Features:
 * - Per-weapon crosshair style (cross, dot, circle, cross_dot)
 * - COD-style spread: hip-fire widens gap, ADS tightens to center
 * - Movement spread: running widens crosshair slightly
 * - Damage hit flash: crosshair turns the damage color for ~200ms on a hit
 * - Cvars: cg_crosshair, cg_crosshairSize, cg_crosshairColor, cg_crosshairAlpha
 */

import { Cvar } from "../../../engine/core/Cvar";
import { WEAPONS } from "../../../shared/entities/definitions/weapons/WeaponsTable";
import { type CrosshairConfig, fireIntervalTicks, type WeaponDef } from "../../../shared/entities/WeaponDef";
import { bloomIdleSeconds, coolSpreadHeat, heatAfterShot } from "../../../shared/SpreadUtils";
import { DEFAULT_PHYSICS_TICK_RATE } from "../../../shared/server/simulation/physics/constants";
import { getAmmoStatus } from "./AmmoStatus";
import { type HitLocationName, isHeadHit } from "./HitLocationName";
import type { HUDState } from "./HUDState";

// ============================================================================
// Default Crosshair Config (fallback when weapon has no crosshair field)
// ============================================================================

const DEFAULT_CROSSHAIR: CrosshairConfig = {
  style: "cross",
  baseGap: 4,
  lineLength: 6,
  lineWidth: 2,
};

// ============================================================================
// Crosshair Class
// ============================================================================

export class Crosshair {
  private static instance: Crosshair | null = null;

  // DOM
  private container: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  // State

  /** Aborted by dispose(), so the document listener below never outlives this overlay. */
  private listeners: AbortController | null = null;

  // Damage flash
  private hitFlashUntil: number = 0; // performance.now() timestamp
  /**
   * Spread bloom of the weapon last fired, 0..1, as of `bloomAt` (seconds),
   * following the server's heat rule from our own shots: the gap opens while
   * the trigger is held and closes when it is let go.
   */
  private bloom = 0;
  private bloomAt = 0;
  private bloomWeapon: Pick<WeaponDef, "spreadBloom" | "fireRate" | "fireIntervalTicks"> | null = null;
  /** Extra gap at full bloom from the hip, in pixels at the reference size. */
  private readonly BLOOM_GAP = 12;
  private readonly HIT_FLASH_DURATION = 200; // ms
  /** A head hit holds the flash half as long again, so it reads as a different kind of hit. */
  private readonly HEAD_HIT_FLASH_DURATION = 300; // ms

  static getInstance(): Crosshair {
    if (!Crosshair.instance) {
      Crosshair.instance = new Crosshair();
    }
    return Crosshair.instance;
  }

  private constructor() {}

  // ========================================================================
  // Lifecycle
  // ========================================================================

  /**
   * Create DOM overlay. Call once when entering game.
   */
  init(): void {
    if (this.container) return; // Already initialized

    // Container: fixed center of screen, no pointer events
    this.container = document.createElement("div");
    this.container.id = "crosshair-overlay";
    this.container.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            pointer-events: none;
            z-index: 1000;
        `;

    // Canvas: sized by cvar
    const size = (Cvar.get("cg_crosshairSize") as number) ?? 32;
    this.canvas = document.createElement("canvas");
    this.canvas.width = size * 2;
    this.canvas.height = size * 2;
    this.canvas.style.cssText = `image-rendering: pixelated;`;

    this.ctx = this.canvas.getContext("2d")!;
    this.container.appendChild(this.canvas);
    document.body.appendChild(this.container);

    // Hide crosshair when pointer lock is lost (pause menu / ESC)
    this.listeners = new AbortController();
    document.addEventListener(
      "pointerlockchange",
      () => {
        if (!document.pointerLockElement && this.container) {
          this.container.style.display = "none";
        }
      },
      { signal: this.listeners.signal },
    );
  }

  /**
   * Remove DOM. Call when leaving game.
   */
  dispose(): void {
    this.listeners?.abort();
    this.listeners = null;
    if (this.container) {
      this.container.remove();
      this.container = null;
      this.canvas = null;
      this.ctx = null;
    }
    Crosshair.instance = null;
  }

  // ========================================================================
  // Hit Flash
  // ========================================================================

  /**
   * Flash the crosshair with damage color. Called when local player deals damage.
   */
  /** One of our own shots: opens the gap for a weapon whose spread blooms. */
  notifyFired(weapon: Pick<WeaponDef, "spreadBloom" | "fireRate" | "fireIntervalTicks"> | undefined): void {
    if (!weapon?.spreadBloom) return;
    const now = performance.now() / 1000;
    this.bloom = heatAfterShot(weapon, this.bloomNow(now));
    this.bloomWeapon = weapon;
    this.bloomAt = now;
  }

  /** The bloom at `now` (seconds), drained by however long the trigger has been off. */
  private bloomNow(now: number): number {
    const weapon = this.bloomWeapon;
    if (!weapon) return 0;
    const refire = fireIntervalTicks(weapon) / DEFAULT_PHYSICS_TICK_RATE;
    return coolSpreadHeat(weapon, this.bloom, bloomIdleSeconds(now - this.bloomAt, refire));
  }

  notifyHit(hitLocation?: HitLocationName): void {
    const duration = isHeadHit(hitLocation) ? this.HEAD_HIT_FLASH_DURATION : this.HIT_FLASH_DURATION;
    this.hitFlashUntil = performance.now() + duration;
  }

  // ========================================================================
  // Per-frame Update
  // ========================================================================

  /** Use the same equipped weapon and ammo state as the HUD warning banner. */
  updateFromHUD(
    adsProgress: number,
    horizSpeed: number,
    hud: Pick<HUDState, "currentWeapon" | "ammo">,
    isDead: boolean,
    isJoined: boolean,
    watching = false,
  ): void {
    const weaponId = hud.currentWeapon;
    this.update(
      adsProgress,
      horizSpeed,
      WEAPONS[weaponId]?.crosshair,
      isDead,
      isJoined,
      getAmmoStatus(weaponId, hud.ammo[weaponId]).outOfAmmo,
      watching,
    );
  }

  /**
   * Redraw crosshair. Call once per frame.
   *
   * @param adsProgress  0 = hip-fire, 1 = fully ADS
   * @param horizSpeed   Horizontal speed (units/sec) for movement spread
   * @param weaponConfig Per-weapon crosshair config (or null for default)
   * @param isDead       Hide crosshair when dead
   * @param isJoined     Only show when actually in-game
   * @param outOfAmmo    Draw a large red X instead of the normal reticle
   * @param watching     Behind someone else's eyes (a demo): shown without
   *                     being in the game or holding the pointer
   */
  update(
    adsProgress: number,
    horizSpeed: number,
    weaponConfig: CrosshairConfig | null | undefined,
    isDead: boolean,
    isJoined: boolean,
    outOfAmmo: boolean = false,
    watching: boolean = false,
  ): void {
    if (!this.ctx || !this.canvas || !this.container) return;

    // Cvar: crosshair enabled?
    const enabled = ((Cvar.get("cg_crosshair") as number) ?? 1) > 0;

    // Hide conditions: disabled, dead, not joined, or pointer lock lost (pause menu)
    const hasPointerLock = !!document.pointerLockElement;
    const shouldShow = enabled && !isDead && (watching || (isJoined && hasPointerLock));
    this.container.style.display = shouldShow ? "" : "none";
    if (!shouldShow) return;

    const config = weaponConfig ?? DEFAULT_CROSSHAIR;

    // Cvar values
    const size = (Cvar.get("cg_crosshairSize") as number) ?? 32;
    const colorHex = (Cvar.get("cg_crosshairColor") as string) ?? "00FF00";
    const alpha = (Cvar.get("cg_crosshairAlpha") as number) ?? 0.9;
    const spreadEnabled = ((Cvar.get("cg_crosshairSpread") as number) ?? 1) > 0;
    const hitColorHex = (Cvar.get("cg_crosshairDmgColor") as string) ?? "FF0000";

    // Resize canvas if needed
    const canvasSize = size * 2;
    if (this.canvas.width !== canvasSize || this.canvas.height !== canvasSize) {
      this.canvas.width = canvasSize;
      this.canvas.height = canvasSize;
    }

    // Determine color: damage flash overrides normal color
    const now = performance.now();
    const isFlashing = now < this.hitFlashUntil;
    const hex = isFlashing ? hitColorHex : (config.color ?? colorHex);
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const color = `rgba(${r}, ${g}, ${b}, ${alpha})`;

    // Compute spread gap
    let gap = config.baseGap;
    if (spreadEnabled) {
      // ADS tightens: gap scales down with ADS progress
      gap *= 1.0 - adsProgress;
      // Movement widens: up to 8px extra when running full speed (400 u/s)
      const movementSpread = Math.min(horizSpeed / 400, 1.0) * 8;
      gap += movementSpread * (1.0 - adsProgress * 0.5); // ADS reduces movement spread too
      // Bloom: the cone opening under sustained fire, less of it when aimed
      gap += this.bloomNow(now / 1000) * this.BLOOM_GAP * (1.0 - adsProgress * 0.7);
    }
    gap = Math.round(gap);

    // Scale line dimensions by size cvar ratio
    const sizeScale = size / 24; // 24 = reference size
    const lineLen = Math.round(config.lineLength * sizeScale);
    const lineW = Math.max(1, Math.round(config.lineWidth * sizeScale));

    // Clear
    const ctx = this.ctx;
    ctx.clearRect(0, 0, canvasSize, canvasSize);

    const cx = canvasSize / 2;
    const cy = canvasSize / 2;

    // Out of ammo: override everything with a bold red X (visible at a glance).
    if (outOfAmmo) {
      this.drawBigX(ctx, cx, cy, size, alpha);
      return;
    }

    // Draw based on style. Each primitive paints a dark 1px underlay first so the
    // reticle reads on any background (COD/Quake style contrast outline).
    switch (config.style) {
      case "dot":
        this.drawDot(ctx, cx, cy, lineW, color);
        break;

      case "cross":
        this.drawCross(ctx, cx, cy, gap, lineLen, lineW, color);
        break;

      case "cross_dot":
        this.drawCross(ctx, cx, cy, gap, lineLen, lineW, color);
        this.drawDot(ctx, cx, cy, lineW, color);
        break;

      case "circle":
        this.drawCircle(ctx, cx, cy, Math.max(3, gap + 3), lineW, color);
        this.drawDot(ctx, cx, cy, lineW, color);
        break;
    }
  }

  // ========================================================================
  // Drawing Primitives
  // ========================================================================

  /** Dark contrast outline drawn under every reticle stroke. */
  private static readonly OUTLINE = "rgba(0, 0, 0, 0.85)";

  /** Fill a rect with a 1px dark border underneath (crisp contrast halo). */
  private outlinedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
    ctx.fillStyle = Crosshair.OUTLINE;
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }

  private drawDot(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
    const half = Math.max(1, Math.floor(size / 2));
    this.outlinedRect(ctx, cx - half, cy - half, half * 2, half * 2, color);
  }

  private drawCross(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    gap: number,
    length: number,
    width: number,
    color: string,
  ): void {
    const half = Math.max(1, Math.floor(width / 2));

    // Top / Bottom / Left / Right arms
    this.outlinedRect(ctx, cx - half, cy - gap - length, width, length, color);
    this.outlinedRect(ctx, cx - half, cy + gap, width, length, color);
    this.outlinedRect(ctx, cx - gap - length, cy - half, length, width, color);
    this.outlinedRect(ctx, cx + gap, cy - half, length, width, color);
  }

  private drawCircle(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    lineWidth: number,
    color: string,
  ): void {
    // Dark underlay ring, then the colored ring on top.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = Crosshair.OUTLINE;
    ctx.lineWidth = lineWidth + 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  /** Out-of-ammo reticle: a bold red X with a dark contrast outline. */
  private drawBigX(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, alpha: number): void {
    const reach = size * 0.7; // spans most of the canvas
    const gap = Math.max(3, size * 0.18); // small hole at the center
    const w = Math.max(3, Math.round(size / 8));

    const drawStroke = (color: string, lineWidth: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      // Two diagonals, each split around the center gap.
      ctx.beginPath();
      ctx.moveTo(cx - reach, cy - reach);
      ctx.lineTo(cx - gap, cy - gap);
      ctx.moveTo(cx + gap, cy + gap);
      ctx.lineTo(cx + reach, cy + reach);
      ctx.moveTo(cx + reach, cy - reach);
      ctx.lineTo(cx + gap, cy - gap);
      ctx.moveTo(cx - gap, cy + gap);
      ctx.lineTo(cx - reach, cy + reach);
      ctx.stroke();
    };

    drawStroke(Crosshair.OUTLINE, w + 4);
    drawStroke(`rgba(255, 40, 40, ${Math.max(alpha, 0.9)})`, w);
    ctx.lineCap = "butt";
  }
}

// ============================================================================
// Register Cvars
// ============================================================================

Cvar.register("cg_crosshair", 1, {
  type: "int",
  min: 0,
  max: 1,
  description: "Enable crosshair (0 = off, 1 = on)",
});

Cvar.register("cg_crosshairSize", 32, {
  type: "int",
  min: 8,
  max: 64,
  description: "Crosshair size in pixels (half-extent)",
});

Cvar.register("cg_crosshairColor", "00FF00", {
  type: "string",
  description: "Crosshair color (hex RGB without #)",
});

Cvar.register("cg_crosshairAlpha", 0.9, {
  type: "float",
  min: 0.1,
  max: 1.0,
  description: "Crosshair opacity",
});

Cvar.register("cg_crosshairSpread", 1, {
  type: "int",
  min: 0,
  max: 1,
  description: "Enable dynamic crosshair spread (ADS + movement)",
});

Cvar.register("cg_crosshairDmgColor", "FF0000", {
  type: "string",
  description: "Crosshair color on hit confirmation (hex RGB without #)",
});
