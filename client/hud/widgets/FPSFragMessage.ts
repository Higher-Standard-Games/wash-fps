// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../FPSHudWidget';
import type { HUDState } from '../FPSHudWidget';



// =============================================================================
// Phase 2: Frag Message
// =============================================================================

/**
 * FPSFragMessage - "You fragged PLAYER" center screen message
 * 
 * Reads kill feed and shows a message when the local player gets a kill.
 * Auto-removes after animation completes.
 */
export class FPSFragMessage implements FPSHudWidget {
    private element: HTMLElement;
    private lastKillCount: number = 0;
    private localPlayerId: string = '';

    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'fps-frag-container';
        this.element.style.display = 'flex';
        this.element.style.flexDirection = 'column';
        this.element.style.alignItems = 'center';
        this.element.style.gap = '4px';
    }

    /**
     * Set the local player ID for detecting own kills
     */
    public setLocalPlayerId(id: string): void {
        this.localPlayerId = id;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        const feed = state.killFeed;
        if (feed.length === this.lastKillCount) return;

        // Check new entries for kills by local player
        const newEntries = feed.slice(this.lastKillCount);
        this.lastKillCount = feed.length;

        for (const kill of newEntries) {
            // Skip if we don't know localPlayerId yet
            if (!this.localPlayerId) continue;
            if (kill.killerId !== this.localPlayerId) continue;
            if (kill.killerId === kill.victimId) continue; // No self-kill message

            this.showFragMessage(kill.victimId);
        }
    }

    private showFragMessage(victimName: string): void {
        const msg = document.createElement('div');
        msg.className = 'fps-frag-message';
        msg.textContent = `FRAGGED ${victimName}`;
        this.element.appendChild(msg);

        // Remove after animation (2.5s float-up)
        setTimeout(() => msg.remove(), 2600);
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
