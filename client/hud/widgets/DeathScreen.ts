// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../HudWidget';
import type { HUDState } from '../HudWidget';



// =============================================================================
// Phase 3: Death Screen
// =============================================================================

/**
 * FPSDeathScreen - Shows when player dies
 *
 * Reads HUDState.dead and shows/hides accordingly.
 * Shows killer name if known from the latest kill feed entry.
 */
export class FPSDeathScreen implements FPSHudWidget {
    private element: HTMLElement;
    private titleEl: HTMLElement;
    private killerEl: HTMLElement;
    private respawnEl: HTMLElement;
    private wasAlive: boolean = true;

    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'fps-death-screen';
        this.element.style.display = 'none';

        this.titleEl = document.createElement('div');
        this.titleEl.className = 'fps-death-title';
        this.titleEl.textContent = 'YOU DIED';
        this.element.appendChild(this.titleEl);

        this.killerEl = document.createElement('div');
        this.killerEl.className = 'fps-death-killer';
        this.element.appendChild(this.killerEl);

        this.respawnEl = document.createElement('div');
        this.respawnEl.className = 'fps-death-respawn';
        this.respawnEl.textContent = 'Waiting to respawn...';
        this.element.appendChild(this.respawnEl);
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        if (state.dead && this.wasAlive) {
            // Just died ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â show death screen
            this.wasAlive = false;

            // Try to find killer from latest kill feed entry
            const feed = state.killFeed;
            if (feed.length > 0) {
                const lastKill = feed[feed.length - 1];
                this.killerEl.innerHTML = `Killed by <span class="fps-death-killer-name">${this.escapeHtml(lastKill.killerId)}</span>`;
            } else {
                this.killerEl.textContent = '';
            }

            this.element.style.display = '';
        } else if (!state.dead && !this.wasAlive) {
            // Respawned ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â hide death screen
            this.wasAlive = true;
            this.element.style.display = 'none';
        }
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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
