// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../HudWidget';
import type { HUDState } from '../HudWidget';
import { MatchStateManager } from '../../MatchStateManager';



/**
 * FPSTimer - Match timer display
 */
export class FPSTimer implements FPSHudWidget {
    private element: HTMLElement;
    private currentTime: string = '';

    constructor() {
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const el = document.createElement('div');
        el.className = 'fps-timer manga-panel';

        // Corner brackets
        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        el.appendChild(corners);

        return el;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(_state: HUDState): void {
        const match = MatchStateManager.getInstance();
        const timeRemaining = match.timeRemaining;
        if (timeRemaining <= 0 && match.isWarmup()) {
            // No time limit during warmup
            if (this.currentTime !== '') {
                this.currentTime = '';
                const textNode = this.element.querySelector('.fps-timer-text');
                if (textNode) textNode.textContent = '';
            }
            return;
        }

        const timeStr = match.getTimeString();

        if (timeStr === this.currentTime) return;
        this.currentTime = timeStr;

        // Keep corners, update text
        // Re-create inner text node without destroying corners
        const textNode = this.element.querySelector('.fps-timer-text') || (() => {
            const span = document.createElement('span');
            span.className = 'fps-timer-text';
            this.element.appendChild(span);
            return span;
        })();
        (textNode as HTMLElement).textContent = timeStr;

        // Warning states
        this.element.classList.remove('fps-timer--warning', 'fps-timer--critical');
        if (timeRemaining <= 10) {
            this.element.classList.add('fps-timer--critical');
        } else if (timeRemaining <= 30) {
            this.element.classList.add('fps-timer--warning');
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
