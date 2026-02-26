// Extracted from FPSHud.ts



// =============================================================================
// Phase 3: Damage Indicators
// =============================================================================

/**
 * FPSDamageIndicators - Directional damage arrows around crosshair
 *
 * Call showDamage(angleRadians) to display an indicator from a direction.
 * Arrows auto-fade via CSS animation.
 */
export class FPSDamageIndicators {
    private container: HTMLElement;

    constructor() {
        this.container = document.createElement('div');
        this.container.className = 'fps-damage-indicators';
        document.body.appendChild(this.container);
    }

    /**
     * Show a damage indicator from a direction
     * @param angleRad Angle in radians (0 = right, PI/2 = bottom, etc.)
     */
    public showDamage(angleRad: number): void {
        const arrow = document.createElement('div');
        arrow.className = 'fps-damage-arrow';

        // Position the arrow on the edge of the indicator circle
        const radius = 80; // Distance from center
        const deg = (angleRad * 180) / Math.PI;
        const x = Math.cos(angleRad) * radius;
        const y = Math.sin(angleRad) * radius;

        arrow.style.left = `calc(50% + ${x}px * var(--ui-scale, 1))`;
        arrow.style.top = `calc(50% + ${y}px * var(--ui-scale, 1))`;
        arrow.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;

        this.container.appendChild(arrow);

        // Remove after animation (0.6s)
        setTimeout(() => arrow.remove(), 650);
    }

    public destroy(): void {
        this.container.remove();
    }
}
