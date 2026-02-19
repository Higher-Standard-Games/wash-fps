/**
 * Crosshair — Dynamic canvas-drawn crosshair with ADS spread and damage flash
 *
 * Features:
 * - Per-weapon crosshair style (cross, dot, circle, cross_dot)
 * - COD-style spread: hip-fire widens gap, ADS tightens to center
 * - Movement spread: running widens crosshair slightly
 * - Damage hit flash: crosshair turns damage color for ~200ms on hit (Warsow/QL)
 * - Cvars: cg_crosshair, cg_crosshairSize, cg_crosshairColor, cg_crosshairAlpha
 */

import { Cvar } from '../../../engine/core/Cvar';
import type { CrosshairConfig } from '../server/weapons/WeaponDef';

// ============================================================================
// Default Crosshair Config (fallback when weapon has no crosshair field)
// ============================================================================

const DEFAULT_CROSSHAIR: CrosshairConfig = {
    style: 'cross',
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

    // Damage flash
    private hitFlashUntil: number = 0;  // performance.now() timestamp
    private readonly HIT_FLASH_DURATION = 200;  // ms (Warsow default)

    static getInstance(): Crosshair {
        if (!Crosshair.instance) {
            Crosshair.instance = new Crosshair();
        }
        return Crosshair.instance;
    }

    private constructor() { }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Create DOM overlay. Call once when entering game.
     */
    init(): void {
        if (this.container) return;  // Already initialized

        // Container: fixed center of screen, no pointer events
        this.container = document.createElement('div');
        this.container.id = 'crosshair-overlay';
        this.container.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            pointer-events: none;
            z-index: 1000;
        `;

        // Canvas: sized by cvar
        const size = Cvar.get('cg_crosshairSize') as number ?? 24;
        this.canvas = document.createElement('canvas');
        this.canvas.width = size * 2;
        this.canvas.height = size * 2;
        this.canvas.style.cssText = `image-rendering: pixelated;`;

        this.ctx = this.canvas.getContext('2d')!;
        this.container.appendChild(this.canvas);
        document.body.appendChild(this.container);
    }

    /**
     * Remove DOM. Call when leaving game.
     */
    dispose(): void {
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
    notifyHit(): void {
        this.hitFlashUntil = performance.now() + this.HIT_FLASH_DURATION;
    }

    // ========================================================================
    // Per-frame Update
    // ========================================================================

    /**
     * Redraw crosshair. Call once per frame.
     *
     * @param adsProgress  0 = hip-fire, 1 = fully ADS
     * @param horizSpeed   Horizontal speed (units/sec) for movement spread
     * @param weaponConfig Per-weapon crosshair config (or null for default)
     * @param isDead       Hide crosshair when dead
     * @param isJoined     Only show when actually in-game
     */
    update(
        adsProgress: number,
        horizSpeed: number,
        weaponConfig: CrosshairConfig | null | undefined,
        isDead: boolean,
        isJoined: boolean,
    ): void {
        if (!this.ctx || !this.canvas || !this.container) return;

        // Cvar: crosshair enabled?
        const enabled = (Cvar.get('cg_crosshair') as number ?? 1) > 0;

        // Hide conditions: disabled, dead, not joined
        const shouldShow = enabled && !isDead && isJoined;
        this.container.style.display = shouldShow ? '' : 'none';
        if (!shouldShow) return;

        const config = weaponConfig ?? DEFAULT_CROSSHAIR;

        // Cvar values
        const size = Cvar.get('cg_crosshairSize') as number ?? 24;
        const colorHex = Cvar.get('cg_crosshairColor') as string ?? '00FF00';
        const alpha = Cvar.get('cg_crosshairAlpha') as number ?? 0.9;
        const spreadEnabled = (Cvar.get('cg_crosshairSpread') as number ?? 1) > 0;
        const hitColorHex = Cvar.get('cg_crosshairDmgColor') as string ?? 'FF0000';

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
            gap *= (1.0 - adsProgress);
            // Movement widens: up to 8px extra when running full speed (400 u/s)
            const movementSpread = Math.min(horizSpeed / 400, 1.0) * 8;
            gap += movementSpread * (1.0 - adsProgress * 0.5);  // ADS reduces movement spread too
        }
        gap = Math.round(gap);

        // Scale line dimensions by size cvar ratio
        const sizeScale = size / 24;  // 24 = reference size
        const lineLen = Math.round(config.lineLength * sizeScale);
        const lineW = Math.max(1, Math.round(config.lineWidth * sizeScale));

        // Clear
        const ctx = this.ctx;
        ctx.clearRect(0, 0, canvasSize, canvasSize);

        const cx = canvasSize / 2;
        const cy = canvasSize / 2;

        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = lineW;

        // Draw based on style
        switch (config.style) {
            case 'dot':
                this.drawDot(ctx, cx, cy, lineW);
                break;

            case 'cross':
                this.drawCross(ctx, cx, cy, gap, lineLen, lineW);
                break;

            case 'cross_dot':
                this.drawCross(ctx, cx, cy, gap, lineLen, lineW);
                this.drawDot(ctx, cx, cy, lineW);
                break;

            case 'circle':
                this.drawCircle(ctx, cx, cy, Math.max(3, gap + 3), lineW);
                this.drawDot(ctx, cx, cy, lineW);
                break;
        }
    }

    // ========================================================================
    // Drawing Primitives
    // ========================================================================

    private drawDot(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
        const half = Math.max(1, Math.floor(size / 2));
        ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
    }

    private drawCross(
        ctx: CanvasRenderingContext2D,
        cx: number, cy: number,
        gap: number, length: number, width: number,
    ): void {
        const half = Math.max(1, Math.floor(width / 2));

        // Top
        ctx.fillRect(cx - half, cy - gap - length, width, length);
        // Bottom
        ctx.fillRect(cx - half, cy + gap, width, length);
        // Left
        ctx.fillRect(cx - gap - length, cy - half, length, width);
        // Right
        ctx.fillRect(cx + gap, cy - half, length, width);
    }

    private drawCircle(
        ctx: CanvasRenderingContext2D,
        cx: number, cy: number,
        radius: number, lineWidth: number,
    ): void {
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.lineWidth = lineWidth;
        ctx.stroke();
    }
}

// ============================================================================
// Register Cvars
// ============================================================================

Cvar.register('cg_crosshair', 1, {
    type: 'int',
    min: 0,
    max: 1,
    description: 'Enable crosshair (0 = off, 1 = on)',
});

Cvar.register('cg_crosshairSize', 24, {
    type: 'int',
    min: 8,
    max: 64,
    description: 'Crosshair size in pixels (half-extent)',
});

Cvar.register('cg_crosshairColor', '00FF00', {
    type: 'string',
    description: 'Crosshair color (hex RGB without #)',
});

Cvar.register('cg_crosshairAlpha', 0.9, {
    type: 'float',
    min: 0.1,
    max: 1.0,
    description: 'Crosshair opacity',
});

Cvar.register('cg_crosshairSpread', 1, {
    type: 'int',
    min: 0,
    max: 1,
    description: 'Enable dynamic crosshair spread (ADS + movement)',
});

Cvar.register('cg_crosshairDmgColor', 'FF0000', {
    type: 'string',
    description: 'Crosshair color on hit confirmation (hex RGB without #)',
});
