// Extracted from FPSHud.ts
import { MangaPanelDialog } from './MangaPanelDialog';



// =============================================================================
// Phase 4: Settings Overlay
// =============================================================================

export interface SettingsTab {
    id: string;
    label: string;
    content: HTMLElement;
}

/**
 * FPSSettingsOverlay - Tabbed settings dialog
 *
 * Provides a tabbed interface for Video, Audio, and Controls settings.
 * Each tab can contain sections with sliders, toggles, and keybinds.
 */
export class FPSSettingsOverlay extends MangaPanelDialog {
    private tabs: SettingsTab[] = [];
    private tabBar: HTMLElement;
    private contentContainer: HTMLElement;
    private onChangeCallback: ((key: string, value: any) => void) | null = null;

    constructor() {
        super('SETTINGS', 'fps-settings');

        // Footer with Apply/Close
        const applyBtn = this.createButton('Apply', 'fps-btn--primary', () => {
            this.close();
        });
        const closeBtn = this.createButton('Close', '', () => {
            this.close();
        });
        this.footerEl.appendChild(closeBtn);
        this.footerEl.appendChild(applyBtn);

        // Tab bar (inserted above body)
        this.tabBar = document.createElement('div');
        this.tabBar.className = 'fps-settings-tabs';
        this.dialog.insertBefore(this.tabBar, this.bodyEl);

        // Content container (replaces body padding for tab content)
        this.contentContainer = this.bodyEl;

        // Create default tabs
        this.addTab('video', 'Video', this.createVideoTab());
        this.addTab('audio', 'Audio', this.createAudioTab());
        this.addTab('controls', 'Controls', this.createControlsTab());

        // Activate first tab
        this.switchTab('video');
    }

    public onChange(callback: (key: string, value: any) => void): void {
        this.onChangeCallback = callback;
    }

    private addTab(id: string, label: string, content: HTMLElement): void {
        const tab: SettingsTab = { id, label, content };
        this.tabs.push(tab);

        const btn = document.createElement('button');
        btn.className = 'fps-settings-tab';
        btn.textContent = label;
        btn.dataset.tabId = id;
        btn.addEventListener('click', () => this.switchTab(id));
        this.tabBar.appendChild(btn);
    }

    private switchTab(tabId: string): void {

        // Update tab bar
        for (const btn of this.tabBar.children) {
            const el = btn as HTMLElement;
            el.classList.toggle('fps-settings-tab--active', el.dataset.tabId === tabId);
        }

        // Update content
        this.contentContainer.innerHTML = '';
        const tab = this.tabs.find(t => t.id === tabId);
        if (tab) {
            this.contentContainer.appendChild(tab.content);
        }
    }

    // =========================================================================
    // Tab Content Builders
    // =========================================================================

    private createVideoTab(): HTMLElement {
        const container = document.createElement('div');

        container.appendChild(this.createSection('Display', [
            this.createSliderRow('FOV', 'video.fov', 70, 120, 90),
            this.createToggleRow('VSync', 'video.vsync', true),
            this.createToggleRow('Fullscreen', 'video.fullscreen', false),
        ]));

        container.appendChild(this.createSection('Graphics', [
            this.createSliderRow('Render Scale', 'video.renderScale', 50, 100, 100, '%'),
            this.createToggleRow('Shadows', 'video.shadows', true),
            this.createToggleRow('Anti-Aliasing', 'video.antiAlias', true),
        ]));

        return container;
    }

    private createAudioTab(): HTMLElement {
        const container = document.createElement('div');

        container.appendChild(this.createSection('Volume', [
            this.createSliderRow('Master', 'audio.master', 0, 100, 80, '%'),
            this.createSliderRow('Effects', 'audio.effects', 0, 100, 100, '%'),
            this.createSliderRow('Music', 'audio.music', 0, 100, 50, '%'),
            this.createSliderRow('Voice', 'audio.voice', 0, 100, 100, '%'),
        ]));

        container.appendChild(this.createSection('Options', [
            this.createToggleRow('Hit Sound', 'audio.hitSound', true),
            this.createToggleRow('Kill Sound', 'audio.killSound', true),
        ]));

        return container;
    }

    private createControlsTab(): HTMLElement {
        const container = document.createElement('div');

        container.appendChild(this.createSection('Mouse', [
            this.createSliderRow('Sensitivity', 'controls.sensitivity', 1, 30, 5),
            this.createToggleRow('Invert Y', 'controls.invertY', false),
            this.createToggleRow('Raw Input', 'controls.rawInput', true),
        ]));

        container.appendChild(this.createSection('Movement', [
            this.createKeybindRow('Forward', 'controls.forward', 'W'),
            this.createKeybindRow('Back', 'controls.back', 'S'),
            this.createKeybindRow('Left', 'controls.left', 'A'),
            this.createKeybindRow('Right', 'controls.right', 'D'),
            this.createKeybindRow('Jump', 'controls.jump', 'Space'),
            this.createKeybindRow('Crouch', 'controls.crouch', 'Ctrl'),
        ]));

        return container;
    }

    // =========================================================================
    // Setting Row Helpers
    // =========================================================================

    private createSection(title: string, rows: HTMLElement[]): HTMLElement {
        const section = document.createElement('div');
        section.className = 'fps-settings-section';

        const titleEl = document.createElement('div');
        titleEl.className = 'fps-settings-section-title';
        titleEl.textContent = title;
        section.appendChild(titleEl);

        for (const row of rows) {
            section.appendChild(row);
        }

        return section;
    }

    private createSliderRow(label: string, key: string, min: number, max: number, value: number, suffix: string = ''): HTMLElement {
        const row = document.createElement('div');
        row.className = 'fps-settings-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'fps-settings-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const slider = document.createElement('input');
        slider.className = 'fps-settings-slider';
        slider.type = 'range';
        slider.min = String(min);
        slider.max = String(max);
        slider.value = String(value);
        row.appendChild(slider);

        const valueEl = document.createElement('span');
        valueEl.className = 'fps-settings-value';
        valueEl.textContent = `${value}${suffix}`;
        row.appendChild(valueEl);

        slider.addEventListener('input', () => {
            valueEl.textContent = `${slider.value}${suffix}`;
            this.onChangeCallback?.(key, Number(slider.value));
        });

        return row;
    }

    private createToggleRow(label: string, key: string, value: boolean): HTMLElement {
        const row = document.createElement('div');
        row.className = 'fps-settings-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'fps-settings-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const toggle = document.createElement('button');
        toggle.className = `fps-settings-toggle ${value ? 'fps-settings-toggle--on' : ''}`;
        toggle.addEventListener('click', () => {
            value = !value;
            toggle.classList.toggle('fps-settings-toggle--on', value);
            this.onChangeCallback?.(key, value);
        });
        row.appendChild(toggle);

        return row;
    }

    private createKeybindRow(label: string, key: string, currentKey: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'fps-settings-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'fps-settings-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const keybindBtn = document.createElement('button');
        keybindBtn.className = 'fps-settings-keybind';
        keybindBtn.textContent = currentKey;

        let listening = false;
        const keyListener = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            keybindBtn.textContent = e.key === ' ' ? 'Space' : e.key;
            keybindBtn.classList.remove('fps-settings-keybind--listening');
            listening = false;
            document.removeEventListener('keydown', keyListener, true);
            this.onChangeCallback?.(key, e.key);
        };

        keybindBtn.addEventListener('click', () => {
            if (listening) {
                keybindBtn.classList.remove('fps-settings-keybind--listening');
                document.removeEventListener('keydown', keyListener, true);
                listening = false;
            } else {
                keybindBtn.classList.add('fps-settings-keybind--listening');
                keybindBtn.textContent = '...';
                listening = true;
                document.addEventListener('keydown', keyListener, true);
            }
        });

        row.appendChild(keybindBtn);
        return row;
    }
}
