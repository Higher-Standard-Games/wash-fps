// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../HudWidget';
import type { HUDState } from '../HudWidget';
import { MatchStateManager, MatchPhase } from '../../MatchStateManager';



// =============================================================================
// Match Lifecycle Widgets (replacing standalone MatchHUD)
// =============================================================================

/**
 * FPSPhaseMessage - Center-screen match phase announcements
 *
 * Subscribes to MatchStateManager.onPhaseChange() for:
 * - Warmup: "WARMUP" + gametype subtitle
 * - Countdown: 3, 2, 1 with pulse animation
 * - Active: "FIGHT!" flash → auto-hide after 2s
 * - PostGame: "MATCH OVER"
 */
export class FPSPhaseMessage implements FPSHudWidget {
    private element: HTMLElement;
    private lastCountdown: number = 0;
    private hideTimeout: ReturnType<typeof setTimeout> | null = null;
    private unsubPhase: (() => void) | null = null;

    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'fps-phase-message hidden';
        // Append directly to body so it's positioned independently of HUD zones
        document.body.appendChild(this.element);

        // Subscribe to phase changes
        const mgr = MatchStateManager.getInstance();
        this.unsubPhase = mgr.onPhaseChange((newPhase, _oldPhase) => {
            this.onPhaseChange(newPhase);
        });
    }

    private onPhaseChange(phase: MatchPhase): void {
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }

        const mgr = MatchStateManager.getInstance();
        switch (phase) {
            case MatchPhase.Warmup:
                this.lastCountdown = 0;
                this.showHtml(
                    `<div class="fps-phase-title">Warmup</div>` +
                    `<div class="fps-phase-subtitle">${mgr.gametypeName}</div>`
                );
                break;

            case MatchPhase.Countdown:
                this.lastCountdown = 0;
                break;

            case MatchPhase.Active:
                this.showHtml(`<div class="fps-phase-fight">Fight!</div>`);
                this.hideTimeout = setTimeout(() => this.hideMessage(), 2000);
                break;

            case MatchPhase.PostGame:
                this.showHtml(
                    `<div class="fps-phase-title">Match Over</div>` +
                    `<div class="fps-phase-subtitle">Next match starting soon...</div>`
                );
                break;
        }
    }

    private showHtml(html: string): void {
        this.element.innerHTML = html;
        this.element.classList.remove('hidden');
    }

    private hideMessage(): void {
        this.element.classList.add('hidden');
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(_state: HUDState): void {
        const mgr = MatchStateManager.getInstance();

        // During warmup: keep showing (update gametype if it changes)
        if (mgr.isWarmup()) {
            this.showHtml(
                `<div class="fps-phase-title">Warmup</div>` +
                `<div class="fps-phase-subtitle">${mgr.gametypeName}</div>`
            );
        }

        // During countdown: update the number with re-triggered animation
        if (mgr.isCountdown()) {
            const num = mgr.getCountdownNumber();
            if (num !== this.lastCountdown && num > 0) {
                this.lastCountdown = num;
                this.showHtml(`<div class="fps-phase-countdown">${num}</div>`);
            }
        }
    }

    public show(): void { this.element.classList.remove('hidden'); }
    public hide(): void { this.element.classList.add('hidden'); }

    public destroy(): void {
        if (this.hideTimeout) clearTimeout(this.hideTimeout);
        if (this.unsubPhase) this.unsubPhase();
        this.element.remove();
    }
}
