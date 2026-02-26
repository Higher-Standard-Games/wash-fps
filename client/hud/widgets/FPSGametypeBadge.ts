// Extracted from FPSHud.ts
import type { FPSHudWidget } from '../FPSHudWidget';
import type { HUDState } from '../FPSHudWidget';
import { MatchStateManager } from '../../MatchStateManager';



/**
 * FPSGametypeBadge - Small gametype name in top-left
 */
export class FPSGametypeBadge implements FPSHudWidget {
    private element: HTMLElement;
    private currentName: string = '';

    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'fps-gametype-badge';
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(_state: HUDState): void {
        const name = MatchStateManager.getInstance().gametypeName || '';
        if (name !== this.currentName) {
            this.currentName = name;
            this.element.textContent = name;
        }
    }

    public show(): void { this.element.style.display = ''; }
    public hide(): void { this.element.style.display = 'none'; }

    public destroy(): void {
        this.element.remove();
    }
}
