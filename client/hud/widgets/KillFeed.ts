// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../HudWidget';
import type { HUDState } from '../HudWidget';



// =============================================================================
// Phase 2: Kill Feed
// =============================================================================

/**
 * FPSKillFeed - Scrolling kill event log (top right)
 */
export class FPSKillFeed implements FPSHudWidget {
    private element: HTMLElement;
    private entries: HTMLElement[] = [];
    private lastKillCount: number = 0;
    private static readonly MAX_VISIBLE = 5;
    private static readonly ENTRY_LIFETIME_MS = 5000;

    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'fps-kill-feed';
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        const feed = state.killFeed;
        if (feed.length === this.lastKillCount) return;

        // Add new entries since last update
        const newEntries = feed.slice(this.lastKillCount);
        this.lastKillCount = feed.length;

        for (const kill of newEntries) {
            const entry = document.createElement('div');
            entry.className = 'fps-kill-entry';

            // Highlight if local player is involved
            // (will need localPlayerId integration later)
            const killer = document.createElement('span');
            killer.className = 'fps-kill-killer';
            killer.textContent = kill.killerId;

            const weapon = document.createElement('span');
            weapon.className = 'fps-kill-weapon';
            weapon.textContent = ` [${kill.weaponId}] `;

            const victim = document.createElement('span');
            victim.className = 'fps-kill-victim';
            victim.textContent = kill.victimId;

            entry.appendChild(killer);
            entry.appendChild(weapon);
            entry.appendChild(victim);

            this.element.appendChild(entry);
            this.entries.push(entry);

            // Auto-remove after lifetime
            setTimeout(() => {
                entry.style.animation = 'fps-fade-out 0.3s ease-out forwards';
                setTimeout(() => {
                    entry.remove();
                    const idx = this.entries.indexOf(entry);
                    if (idx >= 0) this.entries.splice(idx, 1);
                }, 300);
            }, FPSKillFeed.ENTRY_LIFETIME_MS);
        }

        // Trim excess entries
        while (this.entries.length > FPSKillFeed.MAX_VISIBLE) {
            const oldest = this.entries.shift();
            if (oldest) oldest.remove();
        }
    }

    public show(): void {
        this.element.style.display = '';
    }

    public hide(): void {
        this.element.style.display = 'none';
    }

    public destroy(): void {
        this.entries = [];
        this.element.remove();
    }
}
