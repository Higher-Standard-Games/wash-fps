// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../FPSHudWidget';
import type { HUDState } from '../FPSHudWidget';
import { WEAPON_SLOTS } from './FPSWeaponRack';



// =============================================================================
// Phase 2: Pickup Toast
// =============================================================================

/**
 * FPSPickupToast - Shows pickup notifications (weapon, health, armor)
 * 
 * Call showPickup() externally when a pickup event occurs.
 * Messages auto-fade via CSS animation.
 */
export class FPSPickupToast implements FPSHudWidget {
    private element: HTMLElement;
    private lastWeapons: string[] = [];

    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'fps-toast-container';
        this.element.style.display = 'flex';
        this.element.style.flexDirection = 'column';
        this.element.style.alignItems = 'center';
        this.element.style.gap = '4px';
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    /**
     * Show a pickup notification
     */
    public showPickup(text: string): void {
        const toast = document.createElement('div');
        toast.className = 'fps-toast manga-panel';

        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        toast.appendChild(corners);

        const textEl = document.createElement('span');
        textEl.textContent = text;
        toast.appendChild(textEl);

        this.element.appendChild(toast);

        // Remove after animation (2s float-up)
        setTimeout(() => toast.remove(), 2100);
    }

    public update(state: HUDState): void {
        // Auto-detect weapon pickups by comparing weapon arrays
        const weapons = state.weapons;
        if (this.lastWeapons.length > 0 && weapons.length > this.lastWeapons.length) {
            // Find new weapons
            for (const wpn of weapons) {
                if (!this.lastWeapons.includes(wpn)) {
                    const slot = WEAPON_SLOTS.find(s => s.id === wpn);
                    const name = slot ? slot.name : wpn.toUpperCase();
                    this.showPickup(`Picked up ${name}`);
                }
            }
        }
        this.lastWeapons = [...weapons];
    }

    public show(): void {
        this.element.style.display = '';
    }

    public hide(): void {
        this.element.style.display = 'none';
    }

    public destroy(): void {
        this.element.remove();
    }
}
