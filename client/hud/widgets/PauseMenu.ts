// Extracted from FPSHud.ts
import { MangaPanelDialog } from './MangaPanelDialog';



// =============================================================================
// Phase 4: Pause Menu
// =============================================================================

/**
 * FPSPauseMenu - Escape key pause menu
 *
 * Shows Resume, Settings, Disconnect buttons.
 * Extends MangaPanelDialog for consistent styling.
 */
export class FPSPauseMenu extends MangaPanelDialog {
    private onResumeCallback: (() => void) | null = null;
    private onSettingsCallback: (() => void) | null = null;
    private onDisconnectCallback: (() => void) | null = null;
    private onSpectateCallback: (() => void) | null = null;
    private spectateBtn: HTMLElement;
    private resumeBtn: HTMLElement;

    constructor() {
        super('PAUSED', 'fps-pause-menu');

        // Hide header close button (use Resume instead)
        this.headerEl.style.display = 'none';

        // Hide footer
        this.footerEl.style.display = 'none';

        // Add menu buttons
        this.resumeBtn = this.createButton('Resume', 'fps-btn--primary fps-btn--wide', () => {
            this.close();
            this.onResumeCallback?.();
        });

        const settingsBtn = this.createButton('Settings', 'fps-btn--wide', () => {
            this.onSettingsCallback?.();
        });

        // Go Spectator button (only visible when playing)
        this.spectateBtn = this.createButton('Go Spectator', 'fps-btn--wide', () => {
            this.close();
            this.onSpectateCallback?.();
        });
        this.spectateBtn.style.display = 'none'; // Hidden by default

        const separator = document.createElement('div');
        separator.className = 'fps-pause-separator';

        const disconnectBtn = this.createButton('Disconnect', 'fps-btn--danger fps-btn--wide', () => {
            this.close();
            this.onDisconnectCallback?.();
        });

        // Add game title
        const title = document.createElement('div');
        title.className = 'fps-dialog-title';
        title.style.textAlign = 'center';
        title.style.marginBottom = '16px';
        title.textContent = 'PAUSED';
        this.bodyEl.appendChild(title);

        this.bodyEl.appendChild(this.resumeBtn);
        this.bodyEl.appendChild(settingsBtn);
        this.bodyEl.appendChild(this.spectateBtn);
        this.bodyEl.appendChild(separator);
        this.bodyEl.appendChild(disconnectBtn);
    }

    public onResume(callback: () => void): void {
        this.onResumeCallback = callback;
    }

    public onSettings(callback: () => void): void {
        this.onSettingsCallback = callback;
    }

    public onDisconnect(callback: () => void): void {
        this.onDisconnectCallback = callback;
    }

    public onGoSpectate(callback: () => void): void {
        this.onSpectateCallback = callback;
    }

    /** Show/hide the Go Spectator button (only visible when playing) */
    public setSpectateVisible(visible: boolean): void {
        this.spectateBtn.style.display = visible ? '' : 'none';
    }

    /** Show/hide the Resume button (hidden in spectator mode) */
    public setResumeVisible(visible: boolean): void {
        this.resumeBtn.style.display = visible ? '' : 'none';
    }
}
