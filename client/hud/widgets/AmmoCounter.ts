// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../HudWidget';
import type { HUDState } from '../HudWidget';



/**
 * FPSAmmoCounter - Ammo count + weapon name display
 */
/** Max ammo per weapon (mirrors shared/entities/definitions/weapons) */
const WEAPON_MAX_AMMO: Record<string, number> = {
    gunblade: 1,
    machinegun: 100,
    riotgun: 20,
    glauncher: 20,
    rlauncher: 20,
    plasmagun: 200,
    lasergun: 150,
    electrobolt: 10,
    instagun: 5,
};

export class FPSAmmoCounter implements FPSHudWidget {
    private element: HTMLElement;
    private numberEl!: HTMLElement;
    private weaponEl!: HTMLElement;
    private fillEl!: HTMLElement;
    private currentAmmo: number = -1;
    private currentWeapon: string = '';

    constructor() {
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'fps-ammo-counter manga-panel manga-panel--gold';

        // Corner brackets
        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        wrapper.appendChild(corners);

        // Icon on the left (same layout as health/armor bar)
        const icon = document.createElement('div');
        icon.className = 'fps-value-bar-icon';
        icon.textContent = '⬡';
        wrapper.appendChild(icon);

        // Content column (number + label on top, track underneath)
        const content = document.createElement('div');
        content.className = 'fps-value-bar-content';
        wrapper.appendChild(content);

        // Top row: ammo number + weapon name
        const top = document.createElement('div');
        top.className = 'fps-value-bar-top';
        content.appendChild(top);

        this.numberEl = document.createElement('div');
        this.numberEl.className = 'fps-ammo-number';
        this.numberEl.textContent = '—';
        top.appendChild(this.numberEl);

        this.weaponEl = document.createElement('div');
        this.weaponEl.className = 'fps-ammo-weapon';
        this.weaponEl.textContent = '';
        top.appendChild(this.weaponEl);

        // Ammo track (clip bar)
        const track = document.createElement('div');
        track.className = 'fps-value-bar-track';
        content.appendChild(track);

        this.fillEl = document.createElement('div');
        this.fillEl.className = 'fps-value-bar-fill';
        this.fillEl.style.width = '100%';
        track.appendChild(this.fillEl);

        return wrapper;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        const weapon = state.currentWeapon;
        const ammo = state.ammo[weapon] ?? -1;

        // Update weapon name
        if (weapon !== this.currentWeapon) {
            this.currentWeapon = weapon;
            this.weaponEl.textContent = weapon.toUpperCase();
        }

        // Update ammo count
        if (ammo !== this.currentAmmo) {
            const oldAmmo = this.currentAmmo;
            this.currentAmmo = ammo;

            if (ammo < 0) {
                this.numberEl.textContent = '∞';
                this.fillEl.style.width = '100%';
            } else {
                this.numberEl.textContent = String(ammo);
                // Fill bar based on max ammo for current weapon
                const maxAmmo = WEAPON_MAX_AMMO[weapon] ?? 100;
                const percent = Math.max(0, Math.min(100, (ammo / maxAmmo) * 100));
                this.fillEl.style.width = `${percent}%`;
            }

            // Flash on change
            if (oldAmmo >= 0 && ammo < oldAmmo) {
                this.element.classList.remove('fps-flash-loss');
                void this.element.offsetWidth;
                this.element.classList.add('fps-flash-loss');
            }

            // Low ammo warning
            if (ammo >= 0 && ammo <= 5) {
                this.element.classList.add('fps-value-low');
            } else {
                this.element.classList.remove('fps-value-low');
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
