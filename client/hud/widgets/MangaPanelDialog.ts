// Extracted from FPSHud.ts



// =============================================================================
// Phase 4: MangaPanel Dialog Base
// =============================================================================

/**
 * MangaPanelDialog - Reusable modal dialog with Washiki styling
 *
 * Creates a backdrop + MangaPanel dialog with header, body, and footer.
 * Subclass or configure via options for specific dialogs.
 */
export class MangaPanelDialog {
    protected backdrop: HTMLElement;
    protected dialog: HTMLElement;
    protected headerEl: HTMLElement;
    protected titleEl: HTMLElement;
    protected bodyEl: HTMLElement;
    protected footerEl: HTMLElement;
    private visible: boolean = false;
    private onCloseCallback: (() => void) | null = null;
    private escHandler: (e: KeyboardEvent) => void;

    constructor(title: string, extraClass: string = '') {

        // Backdrop
        this.backdrop = document.createElement('div');
        this.backdrop.className = `fps-dialog-backdrop ${extraClass}`.trim();
        this.backdrop.style.display = 'none';
        this.backdrop.addEventListener('click', (e) => {
            if (e.target === this.backdrop) this.close();
        });

        // Dialog panel
        this.dialog = document.createElement('div');
        this.dialog.className = 'fps-dialog manga-panel';

        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        this.dialog.appendChild(corners);

        // Header
        this.headerEl = document.createElement('div');
        this.headerEl.className = 'fps-dialog-header';

        this.titleEl = document.createElement('span');
        this.titleEl.className = 'fps-dialog-title';
        this.titleEl.textContent = title;
        this.headerEl.appendChild(this.titleEl);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'fps-dialog-close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', () => this.close());
        this.headerEl.appendChild(closeBtn);

        this.dialog.appendChild(this.headerEl);

        // Body
        this.bodyEl = document.createElement('div');
        this.bodyEl.className = 'fps-dialog-body';
        this.dialog.appendChild(this.bodyEl);

        // Footer
        this.footerEl = document.createElement('div');
        this.footerEl.className = 'fps-dialog-footer';
        this.dialog.appendChild(this.footerEl);

        this.backdrop.appendChild(this.dialog);
        document.body.appendChild(this.backdrop);

        // Escape key handler
        this.escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.visible) {
                this.close();
                e.preventDefault();
                e.stopPropagation();
            }
        };
    }

    public onClose(callback: () => void): void {
        this.onCloseCallback = callback;
    }

    public open(): void {
        this.visible = true;
        this.backdrop.style.display = '';
        document.addEventListener('keydown', this.escHandler, true);
    }

    public close(): void {
        this.visible = false;
        this.backdrop.style.display = 'none';
        document.removeEventListener('keydown', this.escHandler, true);
        if (this.onCloseCallback) {
            this.onCloseCallback();
        }
    }

    public isOpen(): boolean {
        return this.visible;
    }

    public setTitle(title: string): void {
        this.titleEl.textContent = title;
    }

    /**
     * Create a styled button
     */
    protected createButton(text: string, variant: string = '', onClick?: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = `fps-btn ${variant}`.trim();
        btn.textContent = text;
        if (onClick) btn.addEventListener('click', onClick);
        return btn;
    }

    public destroy(): void {
        document.removeEventListener('keydown', this.escHandler, true);
        this.backdrop.remove();
    }
}
