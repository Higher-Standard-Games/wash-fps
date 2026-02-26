/**
 * FPSHudWidget interface - Base interface for all HUD widgets
 * 
 * Extracted from FPSHud.ts to avoid circular dependencies
 * when widgets are in separate files.
 */
import type { HUDState } from '../HUDState';

export { HUDState };

/**
 * FPS HUD Widget interface
 */
export interface FPSHudWidget {
    /** Get the DOM element */
    getElement(): HTMLElement;
    /** Update with latest data */
    update(state: HUDState): void;
    /** Show the widget */
    show(): void;
    /** Hide the widget */
    hide(): void;
    /** Destroy and clean up */
    destroy(): void;
}
