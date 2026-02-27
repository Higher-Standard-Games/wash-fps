// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../HudWidget';
import type { HUDState } from '../HudWidget';



// =============================================================================
// Frag Counter — displays local player's score next to the timer
// =============================================================================

export class FPSFragCounter implements FPSHudWidget {
    private element: HTMLElement;
    private numberEl!: HTMLElement;
    private currentScore: number = -1;

    constructor() {
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'fps-frag-counter manga-panel';

        // Corner brackets
        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        wrapper.appendChild(corners);

        // Frag number
        this.numberEl = document.createElement('span');
        this.numberEl.className = 'fps-frag-number';
        this.numberEl.textContent = '0';
        wrapper.appendChild(this.numberEl);

        // Label
        const label = document.createElement('span');
        label.className = 'fps-frag-label';
        label.textContent = 'FRAGS';
        wrapper.appendChild(label);

        return wrapper;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        if (!state.localPlayerId) return;

        // Find local player in scoreboard
        const entry = state.scoreboard.find(e => e.playerId === state.localPlayerId);
        const score = entry ? entry.score : 0;

        if (score === this.currentScore) return;
        this.currentScore = score;
        this.numberEl.textContent = String(score);
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
