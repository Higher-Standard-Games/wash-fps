// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../FPSHudWidget';
import type { HUDState } from '../FPSHudWidget';

/**
 * Configuration for a value bar widget
 */
export interface FPSValueBarConfig {
    label: string;
    icon: string;
    color: 'cyan' | 'magenta' | 'gold';
    maxValue: number;
}

/**
 * FPSValueBar - Health/Armor bar with icon, number, and fill bar
 */
export class FPSValueBar implements FPSHudWidget {
    private element: HTMLElement;
    private numberEl!: HTMLElement;
    private fillEl!: HTMLElement;
    private config: FPSValueBarConfig;
    private currentValue: number = 0;

    constructor(config: FPSValueBarConfig) {
        this.config = config;
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = `fps-value-bar fps-value-bar--${this.config.color} manga-panel`;

        // Corner brackets overlay
        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        wrapper.appendChild(corners);

        // Icon
        const icon = document.createElement('div');
        icon.className = 'fps-value-bar-icon';
        icon.textContent = this.config.icon;
        wrapper.appendChild(icon);

        // Content area
        const content = document.createElement('div');
        content.className = 'fps-value-bar-content';

        // Top row: number + label
        const top = document.createElement('div');
        top.className = 'fps-value-bar-top';

        this.numberEl = document.createElement('div');
        this.numberEl.className = 'fps-value-bar-number';
        this.numberEl.textContent = '0';
        top.appendChild(this.numberEl);

        const label = document.createElement('div');
        label.className = 'fps-value-bar-label';
        label.textContent = this.config.label;
        top.appendChild(label);

        content.appendChild(top);

        // Bar track + fill
        const track = document.createElement('div');
        track.className = 'fps-value-bar-track';

        this.fillEl = document.createElement('div');
        this.fillEl.className = 'fps-value-bar-fill';
        this.fillEl.style.width = '0%';
        track.appendChild(this.fillEl);

        content.appendChild(track);
        wrapper.appendChild(content);

        return wrapper;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        let newValue: number;

        if (this.config.label === 'HP') {
            newValue = state.health;
        } else if (this.config.label === 'ARM') {
            newValue = state.armor;
        } else {
            return;
        }

        if (newValue === this.currentValue) return;

        const oldValue = this.currentValue;
        this.currentValue = newValue;

        // Update number
        this.numberEl.textContent = String(Math.max(0, Math.round(newValue)));

        // Update bar fill
        const percent = Math.max(0, Math.min(100, (newValue / this.config.maxValue) * 100));
        this.fillEl.style.width = `${percent}%`;

        // Flash on change
        if (newValue < oldValue) {
            this.element.classList.remove('fps-flash-loss');
            void this.element.offsetWidth;
            this.element.classList.add('fps-flash-loss');
        } else if (newValue > oldValue) {
            this.element.classList.remove('fps-flash-gain');
            void this.element.offsetWidth;
            this.element.classList.add('fps-flash-gain');
        }

        // Low value warning
        if (newValue <= 25) {
            this.element.classList.add('fps-value-low');
            // Critical pulse for health bar only
            if (this.config.label === 'HP') {
                this.element.classList.add('fps-value-bar--critical');
            }
        } else {
            this.element.classList.remove('fps-value-low');
            this.element.classList.remove('fps-value-bar--critical');
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
