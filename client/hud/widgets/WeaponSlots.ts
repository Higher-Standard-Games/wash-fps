// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../HudWidget';
import type { HUDState } from '../HudWidget';
import { getActionKeyLabel } from '../../FPSActions';



// =============================================================================
// Weapon Slots — 3-slot loadout indicator
// =============================================================================

/** Map weapon ID → color variant class */
const WEAPON_COLOR_MAP: Record<string, string> = {
    gunblade: 'cyan',
    machinegun: 'gold',
    riotgun: 'gold',
    glauncher: 'gold',
    rlauncher: 'gold',
    plasmagun: 'green',
    lasergun: 'green',
    electrobolt: 'magenta',
    instagun: 'magenta',
};

/** Map weapon ID → 2-letter abbreviation */
const WEAPON_ABBR: Record<string, string> = {
    gunblade: 'GB',
    machinegun: 'MG',
    riotgun: 'RG',
    glauncher: 'GL',
    rlauncher: 'RL',
    plasmagun: 'PG',
    lasergun: 'LG',
    electrobolt: 'EB',
    instagun: 'IG',
};

/**
 * FPSWeaponSlots — 3-slot loadout indicator in bottom bar
 *
 * Shows 3 boxes: slot 1 (gunblade, always), slots 2-3 (picked-up weapons).
 * Active weapon gets a bright glow border. Color-coded by weapon type.
 */
export class FPSWeaponSlots implements FPSHudWidget {
    private element: HTMLElement;
    private slots: { el: HTMLElement; keyEl: HTMLElement; nameEl: HTMLElement }[] = [];
    private cachedWeapons: string = '';
    private cachedCurrent: string = '';

    constructor() {
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'fps-weapon-slots';

        for (let i = 0; i < 3; i++) {
            const slot = document.createElement('div');
            slot.className = 'fps-weapon-slot fps-weapon-slot--empty manga-panel';

            // Corner brackets (unified with other HUD panels)
            const corners = document.createElement('div');
            corners.className = 'manga-panel-corners';
            slot.appendChild(corners);

            const key = document.createElement('div');
            key.className = 'fps-weapon-slot-key';
            // Dynamic label from InputSystem bindings (e.g. '1', 'Q')
            const weaponActionId = `fps_weapon_${i + 1}`;
            key.textContent = getActionKeyLabel(weaponActionId);
            slot.appendChild(key);

            const name = document.createElement('div');
            name.className = 'fps-weapon-slot-name';
            name.textContent = '—';
            slot.appendChild(name);

            wrapper.appendChild(slot);
            this.slots.push({ el: slot, keyEl: key, nameEl: name });
        }

        return wrapper;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        // Build ordered loadout: gunblade first, then non-gunblade weapons
        const weapons = state.weapons;
        const current = state.currentWeapon;

        // Quick cache check to avoid DOM thrashing
        const weaponKey = weapons.join(',');
        if (weaponKey === this.cachedWeapons && current === this.cachedCurrent) return;
        this.cachedWeapons = weaponKey;
        this.cachedCurrent = current;

        // Ordered loadout: slot 0 = gunblade, slots 1-2 = picked up weapons
        const loadout: (string | null)[] = [null, null, null];
        let pickSlot = 1;
        for (const w of weapons) {
            if (w === 'gunblade') {
                loadout[0] = w;
            } else if (pickSlot <= 2) {
                loadout[pickSlot++] = w;
            }
        }
        // Gunblade is always slot 1
        if (!loadout[0]) loadout[0] = 'gunblade';

        for (let i = 0; i < 3; i++) {
            const slot = this.slots[i];
            const weaponId = loadout[i];
            const isActive = weaponId !== null && weaponId === current;
            const isEmpty = weaponId === null;
            const color = weaponId ? (WEAPON_COLOR_MAP[weaponId] || 'cyan') : '';
            const abbr = weaponId ? (WEAPON_ABBR[weaponId] || weaponId.slice(0, 2).toUpperCase()) : '—';

            // Update name
            slot.nameEl.textContent = abbr;

            // Update classes
            slot.el.className = 'fps-weapon-slot manga-panel';
            if (isEmpty) {
                slot.el.classList.add('fps-weapon-slot--empty');
            } else if (isActive) {
                slot.el.classList.add('fps-weapon-slot--active');
            } else {
                slot.el.classList.add(`fps-weapon-slot--${color}`);
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
        this.element.remove();
    }
}
