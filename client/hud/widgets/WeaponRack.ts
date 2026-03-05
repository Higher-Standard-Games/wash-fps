// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../HudWidget';
import type { HUDState } from '../HudWidget';
import { getActionKeyLabel } from '../../FPSActions';



// =============================================================================
// Phase 2: Weapon Rack
// =============================================================================

/**
 * All weapon IDs in slot order (matches number key bindings 1-9)
 */
export const WEAPON_SLOTS: { id: string; slot: number; name: string }[] = [
    { id: 'blade', slot: 1, name: 'BL' },
    { id: 'machinegun', slot: 2, name: 'MG' },
    { id: 'riotgun', slot: 3, name: 'RG' },
    { id: 'glauncher', slot: 4, name: 'GL' },
    { id: 'rlauncher', slot: 5, name: 'RL' },
    { id: 'plasmagun', slot: 6, name: 'PG' },
    { id: 'lasergun', slot: 7, name: 'LG' },
    { id: 'electrobolt', slot: 8, name: 'EB' },
    { id: 'instagun', slot: 9, name: 'IG' },
];

/**
 * FPSWeaponRack - Vertical weapon inventory (left side)
 */
export class FPSWeaponRack implements FPSHudWidget {
    private element: HTMLElement;
    private slotEls: Map<string, HTMLElement> = new Map();
    private ammoEls: Map<string, HTMLElement> = new Map();
    private lastWeaponHash: string = '';

    constructor() {
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const rack = document.createElement('div');
        rack.className = 'fps-weapon-rack';

        for (const slot of WEAPON_SLOTS) {
            const el = document.createElement('div');
            el.className = 'fps-weapon-slot fps-weapon-slot--empty';

            const key = document.createElement('span');
            key.className = 'fps-weapon-slot-key';
            key.textContent = getActionKeyLabel(`fps_weapon_${slot.slot}`);

            const name = document.createElement('span');
            name.className = 'fps-weapon-slot-name';
            name.textContent = slot.name;

            const ammo = document.createElement('span');
            ammo.className = 'fps-weapon-slot-ammo';
            ammo.textContent = '';

            el.appendChild(key);
            el.appendChild(name);
            el.appendChild(ammo);

            rack.appendChild(el);
            this.slotEls.set(slot.id, el);
            this.ammoEls.set(slot.id, ammo);
        }

        return rack;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        const owned = state.weapons;
        const active = state.currentWeapon;
        const ammoMap = state.ammo;

        // Build a hash to detect changes
        const hash = `${active}|${owned.join(',')}|${JSON.stringify(ammoMap)}`;
        if (hash === this.lastWeaponHash) return;
        this.lastWeaponHash = hash;

        for (const slot of WEAPON_SLOTS) {
            const el = this.slotEls.get(slot.id);
            const ammoEl = this.ammoEls.get(slot.id);
            if (!el || !ammoEl) continue;

            const hasWeapon = owned.includes(slot.id);
            const isActive = active === slot.id;

            // Update classes
            el.classList.toggle('fps-weapon-slot--empty', !hasWeapon);
            el.classList.toggle('fps-weapon-slot--active', isActive);

            // Update ammo
            if (hasWeapon) {
                const ammoCount = ammoMap[slot.id];
                if (ammoCount === undefined || ammoCount < 0) {
                    ammoEl.textContent = '∞'; // Infinite (gunblade)
                } else {
                    ammoEl.textContent = String(ammoCount);
                }
            } else {
                ammoEl.textContent = '';
            }
        }
    }

    public show(): void {
        this.element.style.display = '';
    }

    public hide(): void {
        this.element.style.display = 'none';
    }

    public destroy(): void {
        this.slotEls.clear();
        this.ammoEls.clear();
        this.element.remove();
    }
}
