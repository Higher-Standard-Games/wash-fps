/**
 * FPSHud - FPS Game HUD Manager
 * 
 * Creates and manages the FPS HUD overlay with Washiki Washoi visual style.
 * Handles:
 * - Injecting WashikiTheme CSS and loading fonts
 * - Creating the HUD container with anchor areas
 * - Creating and managing HUD widgets (health, armor, ammo, etc.)
 * - Binding widgets to HUDState data
 * - Update loop for live data
 */

import { UIStyles } from '../../../engine/ui/UIStyles';
import { UITheme } from '../../../engine/ui/UITheme';
import { GamePaths } from '../../../engine/core/GamePaths';
import { CameraSystem } from '../../../engine/camera/CameraSystem';
import { HUDState } from './HUDState';
import { MatchStateManager, MatchPhase } from './MatchStateManager';
import { FPS, getActionKeyLabel } from './FPSActions';

// Import CSS as raw string (Vite)
import washikiTheme from '../../../engine/ui/hud/styles/WashikiTheme.css?raw';

/**
 * HUD anchor positions
 */
type FPSHudArea =
    | 'top-left' | 'top-center' | 'top-right'
    | 'left' | 'center' | 'right'
    | 'bottom-left' | 'bottom-center' | 'bottom-right';

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

export class FPSHud {
    private static instance: FPSHud | null = null;

    private container: HTMLElement | null = null;
    private areas: Map<FPSHudArea, HTMLElement> = new Map();
    private widgets: Map<string, FPSHudWidget> = new Map();
    private updateInterval: number | null = null;
    private running: boolean = false;
    private fontsLoaded: boolean = false;

    // Phase 3: Standalone overlays (not area-based widgets)
    private _scoreboard: FPSScoreboard | null = null;
    private _chat: FPSChat | null = null;
    private _damageIndicators: FPSDamageIndicators | null = null;

    // Phase 4: Dialogs & Menus
    private _pauseMenu: FPSPauseMenu | null = null;
    private _settings: FPSSettingsOverlay | null = null;
    private _pointerLockHandler: (() => void) | null = null;

    private constructor() { }

    public static getInstance(): FPSHud {
        if (!FPSHud.instance) {
            FPSHud.instance = new FPSHud();
        }
        return FPSHud.instance;
    }

    // ===========================================================================
    // Initialization
    // ===========================================================================

    /**
     * Initialize the FPS HUD system
     */
    public async init(): Promise<void> {
        console.log('[FPSHud] Initializing...');

        // 1. Inject WashikiTheme CSS
        UIStyles.injectCSS('washiki-theme', washikiTheme);

        // 2. Load fonts
        await this.loadFonts();

        // 3. Create HUD container and anchor areas
        this.createContainer();

        // 4. Create core widgets
        this.createCoreWidgets();

        // 5. Create standalone overlays
        this._scoreboard = new FPSScoreboard();
        this._chat = new FPSChat();
        this._damageIndicators = new FPSDamageIndicators();

        // 6. Create dialogs & menus
        this._pauseMenu = new FPSPauseMenu();
        this._settings = new FPSSettingsOverlay();

        // Wire Settings button in pause menu to open settings
        this._pauseMenu.onSettings(() => {
            this._pauseMenu?.close();
            this._settings?.open();
        });

        // Wire Resume -> re-request pointer lock (closes menu via onClose callback)
        this._pauseMenu.onResume(() => {
            const canvas = document.querySelector('canvas');
            if (canvas) {
                canvas.requestPointerLock();
            }
        });

        // Wire Disconnect -> reload page (return to lobby)
        this._pauseMenu.onDisconnect(() => {
            window.location.reload();
        });

        // Wire Go Spectator -> switch to spectator mode
        this._pauseMenu.onGoSpectate(async () => {
            const { FPSGameManager } = await import('../FPSGameManager');
            const gm = FPSGameManager.getInstance();
            gm.goSpectator();
        });

        // 7. Listen for pointer lock changes (ESC releases pointer lock -> show pause menu)
        this._pointerLockHandler = () => {
            if (!document.pointerLockElement) {
                // Pointer lock was lost (ESC pressed) — show pause menu
                // Don't show if scoreboard or settings are open
                if (!this._scoreboard?.isVisible() && !this._settings?.isOpen()) {
                    // Show/hide 'Go Spectator' based on player state
                    import('../FPSGameManager').then(({ FPSGameManager }) => {
                        const gm = FPSGameManager.getInstance();
                        this._pauseMenu?.setSpectateVisible(gm.getPlayerState() === 'playing');
                    }).catch(() => { /* ignore */ });
                    this._pauseMenu?.open();
                }
            } else {
                // Pointer lock was acquired — close pause menu
                this._pauseMenu?.close();
            }
        };
        document.addEventListener('pointerlockchange', this._pointerLockHandler);

        console.log(`[FPSHud] Initialized with ${this.widgets.size} widgets + overlays + dialogs`);
    }

    /**
     * Load Orbitron and Rajdhani fonts locally
     */
    private async loadFonts(): Promise<void> {
        const theme = UITheme.getInstance();
        const gamePaths = GamePaths.getInstance();

        // Orbitron (display font) - variable font or static weights
        const orbitronWeights = [
            { weight: '400', file: 'Orbitron-Regular.ttf' },
            { weight: '500', file: 'Orbitron-Medium.ttf' },
            { weight: '600', file: 'Orbitron-SemiBold.ttf' },
            { weight: '700', file: 'Orbitron-Bold.ttf' },
            { weight: '800', file: 'Orbitron-ExtraBold.ttf' },
            { weight: '900', file: 'Orbitron-Black.ttf' },
        ];

        let orbitronLoaded = 0;
        for (const { weight, file } of orbitronWeights) {
            const fontPath = gamePaths.engine(`fonts/Orbitron/static/${file}`);
            const success = await theme.loadFont('Orbitron', fontPath, weight, true);
            if (success) orbitronLoaded++;
        }
        console.log(`[FPSHud] Orbitron font loaded (${orbitronLoaded}/${orbitronWeights.length} weights)`);

        // Rajdhani (body font)
        const rajdhaniWeights = [
            { weight: '300', file: 'Rajdhani-Light.ttf' },
            { weight: '400', file: 'Rajdhani-Regular.ttf' },
            { weight: '500', file: 'Rajdhani-Medium.ttf' },
            { weight: '600', file: 'Rajdhani-SemiBold.ttf' },
            { weight: '700', file: 'Rajdhani-Bold.ttf' },
        ];

        let rajdhaniLoaded = 0;
        for (const { weight, file } of rajdhaniWeights) {
            const fontPath = gamePaths.engine(`fonts/Rajdhani/${file}`);
            const success = await theme.loadFont('Rajdhani', fontPath, weight, true);
            if (success) rajdhaniLoaded++;
        }
        console.log(`[FPSHud] Rajdhani font loaded (${rajdhaniLoaded}/${rajdhaniWeights.length} weights)`);

        this.fontsLoaded = (orbitronLoaded > 0 && rajdhaniLoaded > 0);
        if (!this.fontsLoaded) {
            console.warn('[FPSHud] Some fonts failed to load — HUD will use fallback fonts');
        }
    }

    // ===========================================================================
    // Container & Layout
    // ===========================================================================

    /**
     * Create the HUD container and 9 anchor areas
     */
    private createContainer(): void {
        this.container = document.createElement('div');
        this.container.id = 'fps-hud';
        this.container.className = 'fps-hud-container';
        document.body.appendChild(this.container);

        // Non-bottom positions are direct children
        const topAndMiddle: FPSHudArea[] = [
            'top-left', 'top-center', 'top-right',
            'left', 'center', 'right',
        ];

        for (const pos of topAndMiddle) {
            const area = document.createElement('div');
            area.className = `fps-hud-area fps-hud-${pos}`;
            area.dataset.hudArea = pos;
            this.container.appendChild(area);
            this.areas.set(pos, area);
        }

        // Bottom bar wrapper — spans full width, contains bottom zones
        const bottomBar = document.createElement('div');
        bottomBar.className = 'fps-hud-bottom-bar';
        this.container.appendChild(bottomBar);

        const bottomPositions: FPSHudArea[] = [
            'bottom-left', 'bottom-center', 'bottom-right',
        ];

        for (const pos of bottomPositions) {
            const area = document.createElement('div');
            area.className = `fps-hud-area fps-hud-${pos}`;
            area.dataset.hudArea = pos;
            bottomBar.appendChild(area);
            this.areas.set(pos, area);
        }
    }

    /**
     * Add a widget to a specific area
     */
    public addWidget(id: string, widget: FPSHudWidget, area: FPSHudArea): void {
        const areaEl = this.areas.get(area);
        if (!areaEl) {
            console.warn(`[FPSHud] Area '${area}' not found`);
            return;
        }

        // Remove existing widget with same id
        if (this.widgets.has(id)) {
            this.removeWidget(id);
        }

        this.widgets.set(id, widget);
        areaEl.appendChild(widget.getElement());
    }

    /**
     * Remove a widget
     */
    public removeWidget(id: string): void {
        const widget = this.widgets.get(id);
        if (widget) {
            widget.destroy();
            this.widgets.delete(id);
        }
    }

    /**
     * Get a widget by id
     */
    public getWidget(id: string): FPSHudWidget | undefined {
        return this.widgets.get(id);
    }

    // ===========================================================================
    // Core Widgets
    // ===========================================================================

    /**
     * Create the core HUD widgets (health, armor, ammo)
     */
    private createCoreWidgets(): void {
        // Health bar - bottom left
        this.addWidget('health', new FPSValueBar({
            label: 'HP',
            icon: '♥',
            color: 'cyan',
            maxValue: 100,
        }), 'bottom-left');

        // Armor bar - bottom left (added above health)
        this.addWidget('armor', new FPSValueBar({
            label: 'ARMOR',
            icon: '🛡',
            color: 'magenta',
            maxValue: 100,
        }), 'bottom-left');

        // Weapon slots - bottom right (before ammo)
        this.addWidget('weaponslots', new FPSWeaponSlots(), 'bottom-right');

        // Ammo counter - bottom right
        this.addWidget('ammo', new FPSAmmoCounter(), 'bottom-right');

        // Match timer - top center
        this.addWidget('timer', new FPSTimer(), 'top-center');

        // Frag counter - top center (next to timer)
        this.addWidget('frags', new FPSFragCounter(), 'top-center');

        // Kill feed - top right
        this.addWidget('killfeed', new FPSKillFeed(), 'top-right');

        // Weapon rack - left side
        this.addWidget('weapons', new FPSWeaponRack(), 'left');

        // Frag message - center screen
        this.addWidget('frag', new FPSFragMessage(), 'center');

        // Pickup toast - bottom center
        this.addWidget('pickup', new FPSPickupToast(), 'bottom-center');

        // Death screen - full overlay, managed via widget system
        this.addWidget('death', new FPSDeathScreen(), 'center');

        // Match lifecycle widgets (replacing standalone MatchHUD)
        this.addWidget('phase', new FPSPhaseMessage(), 'top-center');
        this.addWidget('ready', new FPSReadyBar(), 'top-center');
        this.addWidget('gametype', new FPSGametypeBadge(), 'top-left');
    }

    // ===========================================================================
    // Update Loop
    // ===========================================================================

    /**
     * Start the HUD update loop
     */
    public start(intervalMs: number = 50): void {
        if (this.running) return;
        this.running = true;
        this.updateInterval = window.setInterval(() => this.update(), intervalMs);
        console.log(`[FPSHud] Update loop started (${intervalMs}ms)`);
    }

    /**
     * Stop the HUD update loop
     */
    public stop(): void {
        if (!this.running) return;
        this.running = false;
        if (this.updateInterval !== null) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        console.log('[FPSHud] Update loop stopped');
    }

    /**
     * Update all widgets with current HUDState
     */
    private update(): void {
        const state = HUDState.getInstance();
        for (const widget of this.widgets.values()) {
            widget.update(state);
        }
    }

    // ===========================================================================
    // Phase 3: Overlay Accessors
    // ===========================================================================

    /** Get the scoreboard overlay (Tab key toggle) */
    public get scoreboard(): FPSScoreboard | null { return this._scoreboard; }

    /** Get the chat overlay */
    public get chat(): FPSChat | null { return this._chat; }

    /** Get the damage indicators overlay */
    public get damageIndicators(): FPSDamageIndicators | null { return this._damageIndicators; }

    /** Get the pause menu dialog */
    public get pauseMenu(): FPSPauseMenu | null { return this._pauseMenu; }

    /** Get the settings overlay dialog */
    public get settings(): FPSSettingsOverlay | null { return this._settings; }

    // ===========================================================================
    // Visibility
    // ===========================================================================

    /**
     * Show the entire HUD
     */
    public show(): void {
        if (this.container) {
            this.container.style.display = '';
        }
    }

    /**
     * Hide the entire HUD
     */
    public hide(): void {
        if (this.container) {
            this.container.style.display = 'none';
        }
    }

    // ===========================================================================
    // Cleanup
    // ===========================================================================

    /**
     * Destroy the HUD system
     */
    public destroy(): void {
        this.stop();

        for (const widget of this.widgets.values()) {
            widget.destroy();
        }
        this.widgets.clear();
        this.areas.clear();

        // Destroy standalone overlays
        this._scoreboard?.destroy();
        this._scoreboard = null;
        this._chat?.destroy();
        this._chat = null;
        this._damageIndicators?.destroy();
        this._damageIndicators = null;

        // Destroy dialogs
        this._pauseMenu?.destroy();
        this._pauseMenu = null;
        this._settings?.destroy();
        this._settings = null;

        if (this.container) {
            this.container.remove();
            this.container = null;
        }

        UIStyles.removeCSS('washiki-theme');
        FPSHud.instance = null;
        console.log('[FPSHud] Destroyed');
    }
}


// =============================================================================
// Core Widget Implementations
// =============================================================================

/**
 * Configuration for a value bar widget
 */
interface FPSValueBarConfig {
    label: string;
    icon: string;
    color: 'cyan' | 'magenta' | 'gold';
    maxValue: number;
}

/**
 * FPSValueBar - Health/Armor bar with icon, number, and fill bar
 */
export class FPSValueBar implements FPSHudWidget {
    private element: HTMLElement;
    private numberEl!: HTMLElement;
    private fillEl!: HTMLElement;
    private config: FPSValueBarConfig;
    private currentValue: number = 0;

    constructor(config: FPSValueBarConfig) {
        this.config = config;
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = `fps-value-bar fps-value-bar--${this.config.color} manga-panel`;

        // Corner brackets overlay
        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        wrapper.appendChild(corners);

        // Icon
        const icon = document.createElement('div');
        icon.className = 'fps-value-bar-icon';
        icon.textContent = this.config.icon;
        wrapper.appendChild(icon);

        // Content area
        const content = document.createElement('div');
        content.className = 'fps-value-bar-content';

        // Top row: number + label
        const top = document.createElement('div');
        top.className = 'fps-value-bar-top';

        this.numberEl = document.createElement('div');
        this.numberEl.className = 'fps-value-bar-number';
        this.numberEl.textContent = '0';
        top.appendChild(this.numberEl);

        const label = document.createElement('div');
        label.className = 'fps-value-bar-label';
        label.textContent = this.config.label;
        top.appendChild(label);

        content.appendChild(top);

        // Bar track + fill
        const track = document.createElement('div');
        track.className = 'fps-value-bar-track';

        this.fillEl = document.createElement('div');
        this.fillEl.className = 'fps-value-bar-fill';
        this.fillEl.style.width = '0%';
        track.appendChild(this.fillEl);

        content.appendChild(track);
        wrapper.appendChild(content);

        return wrapper;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        let newValue: number;

        if (this.config.label === 'HP') {
            newValue = state.health;
        } else if (this.config.label === 'ARM') {
            newValue = state.armor;
        } else {
            return;
        }

        if (newValue === this.currentValue) return;

        const oldValue = this.currentValue;
        this.currentValue = newValue;

        // Update number
        this.numberEl.textContent = String(Math.max(0, Math.round(newValue)));

        // Update bar fill
        const percent = Math.max(0, Math.min(100, (newValue / this.config.maxValue) * 100));
        this.fillEl.style.width = `${percent}%`;

        // Flash on change
        if (newValue < oldValue) {
            this.element.classList.remove('fps-flash-loss');
            void this.element.offsetWidth;
            this.element.classList.add('fps-flash-loss');
        } else if (newValue > oldValue) {
            this.element.classList.remove('fps-flash-gain');
            void this.element.offsetWidth;
            this.element.classList.add('fps-flash-gain');
        }

        // Low value warning
        if (newValue <= 25) {
            this.element.classList.add('fps-value-low');
            // Critical pulse for health bar only
            if (this.config.label === 'HP') {
                this.element.classList.add('fps-value-bar--critical');
            }
        } else {
            this.element.classList.remove('fps-value-low');
            this.element.classList.remove('fps-value-bar--critical');
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


// =============================================================================
// Weapon Slots — 3-slot loadout indicator
// =============================================================================

/** Map weapon ID → color variant class */
const WEAPON_COLOR_MAP: Record<string, string> = {
    gunblade: 'cyan',
    machinegun: 'gold',
    riotgun: 'gold',
    glauncher: 'gold',
    rlauncher: 'gold',
    plasmagun: 'green',
    lasergun: 'green',
    electrobolt: 'magenta',
    instagun: 'magenta',
};

/** Map weapon ID → 2-letter abbreviation */
const WEAPON_ABBR: Record<string, string> = {
    gunblade: 'GB',
    machinegun: 'MG',
    riotgun: 'RG',
    glauncher: 'GL',
    rlauncher: 'RL',
    plasmagun: 'PG',
    lasergun: 'LG',
    electrobolt: 'EB',
    instagun: 'IG',
};

/**
 * FPSWeaponSlots — 3-slot loadout indicator in bottom bar
 *
 * Shows 3 boxes: slot 1 (gunblade, always), slots 2-3 (picked-up weapons).
 * Active weapon gets a bright glow border. Color-coded by weapon type.
 */
export class FPSWeaponSlots implements FPSHudWidget {
    private element: HTMLElement;
    private slots: { el: HTMLElement; keyEl: HTMLElement; nameEl: HTMLElement }[] = [];
    private cachedWeapons: string = '';
    private cachedCurrent: string = '';

    constructor() {
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'fps-weapon-slots';

        for (let i = 0; i < 3; i++) {
            const slot = document.createElement('div');
            slot.className = 'fps-weapon-slot fps-weapon-slot--empty manga-panel';

            // Corner brackets (unified with other HUD panels)
            const corners = document.createElement('div');
            corners.className = 'manga-panel-corners';
            slot.appendChild(corners);

            const key = document.createElement('div');
            key.className = 'fps-weapon-slot-key';
            // Dynamic label from InputSystem bindings (e.g. '1', 'Q')
            const weaponActionId = `fps_weapon_${i + 1}`;
            key.textContent = getActionKeyLabel(weaponActionId);
            slot.appendChild(key);

            const name = document.createElement('div');
            name.className = 'fps-weapon-slot-name';
            name.textContent = '—';
            slot.appendChild(name);

            wrapper.appendChild(slot);
            this.slots.push({ el: slot, keyEl: key, nameEl: name });
        }

        return wrapper;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        // Build ordered loadout: gunblade first, then non-gunblade weapons
        const weapons = state.weapons;
        const current = state.currentWeapon;

        // Quick cache check to avoid DOM thrashing
        const weaponKey = weapons.join(',');
        if (weaponKey === this.cachedWeapons && current === this.cachedCurrent) return;
        this.cachedWeapons = weaponKey;
        this.cachedCurrent = current;

        // Ordered loadout: slot 0 = gunblade, slots 1-2 = picked up weapons
        const loadout: (string | null)[] = [null, null, null];
        let pickSlot = 1;
        for (const w of weapons) {
            if (w === 'gunblade') {
                loadout[0] = w;
            } else if (pickSlot <= 2) {
                loadout[pickSlot++] = w;
            }
        }
        // Gunblade is always slot 1
        if (!loadout[0]) loadout[0] = 'gunblade';

        for (let i = 0; i < 3; i++) {
            const slot = this.slots[i];
            const weaponId = loadout[i];
            const isActive = weaponId !== null && weaponId === current;
            const isEmpty = weaponId === null;
            const color = weaponId ? (WEAPON_COLOR_MAP[weaponId] || 'cyan') : '';
            const abbr = weaponId ? (WEAPON_ABBR[weaponId] || weaponId.slice(0, 2).toUpperCase()) : '—';

            // Update name
            slot.nameEl.textContent = abbr;

            // Update classes
            slot.el.className = 'fps-weapon-slot manga-panel';
            if (isEmpty) {
                slot.el.classList.add('fps-weapon-slot--empty');
            } else if (isActive) {
                slot.el.classList.add('fps-weapon-slot--active');
            } else {
                slot.el.classList.add(`fps-weapon-slot--${color}`);
            }
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


/**
 * FPSAmmoCounter - Ammo count + weapon name display
 */
/** Max ammo per weapon (mirrors shared/entities/definitions/weapons) */
const WEAPON_MAX_AMMO: Record<string, number> = {
    gunblade: 1,
    machinegun: 100,
    riotgun: 20,
    glauncher: 20,
    rlauncher: 20,
    plasmagun: 200,
    lasergun: 150,
    electrobolt: 10,
    instagun: 5,
};

export class FPSAmmoCounter implements FPSHudWidget {
    private element: HTMLElement;
    private numberEl!: HTMLElement;
    private weaponEl!: HTMLElement;
    private fillEl!: HTMLElement;
    private currentAmmo: number = -1;
    private currentWeapon: string = '';

    constructor() {
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'fps-ammo-counter manga-panel manga-panel--gold';

        // Corner brackets
        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        wrapper.appendChild(corners);

        // Icon on the left (same layout as health/armor bar)
        const icon = document.createElement('div');
        icon.className = 'fps-value-bar-icon';
        icon.textContent = '⬡';
        wrapper.appendChild(icon);

        // Content column (number + label on top, track underneath)
        const content = document.createElement('div');
        content.className = 'fps-value-bar-content';
        wrapper.appendChild(content);

        // Top row: ammo number + weapon name
        const top = document.createElement('div');
        top.className = 'fps-value-bar-top';
        content.appendChild(top);

        this.numberEl = document.createElement('div');
        this.numberEl.className = 'fps-ammo-number';
        this.numberEl.textContent = '—';
        top.appendChild(this.numberEl);

        this.weaponEl = document.createElement('div');
        this.weaponEl.className = 'fps-ammo-weapon';
        this.weaponEl.textContent = '';
        top.appendChild(this.weaponEl);

        // Ammo track (clip bar)
        const track = document.createElement('div');
        track.className = 'fps-value-bar-track';
        content.appendChild(track);

        this.fillEl = document.createElement('div');
        this.fillEl.className = 'fps-value-bar-fill';
        this.fillEl.style.width = '100%';
        track.appendChild(this.fillEl);

        return wrapper;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        const weapon = state.currentWeapon;
        const ammo = state.ammo[weapon] ?? -1;

        // Update weapon name
        if (weapon !== this.currentWeapon) {
            this.currentWeapon = weapon;
            this.weaponEl.textContent = weapon.toUpperCase();
        }

        // Update ammo count
        if (ammo !== this.currentAmmo) {
            const oldAmmo = this.currentAmmo;
            this.currentAmmo = ammo;

            if (ammo < 0) {
                this.numberEl.textContent = '∞';
                this.fillEl.style.width = '100%';
            } else {
                this.numberEl.textContent = String(ammo);
                // Fill bar based on max ammo for current weapon
                const maxAmmo = WEAPON_MAX_AMMO[weapon] ?? 100;
                const percent = Math.max(0, Math.min(100, (ammo / maxAmmo) * 100));
                this.fillEl.style.width = `${percent}%`;
            }

            // Flash on change
            if (oldAmmo >= 0 && ammo < oldAmmo) {
                this.element.classList.remove('fps-flash-loss');
                void this.element.offsetWidth;
                this.element.classList.add('fps-flash-loss');
            }

            // Low ammo warning
            if (ammo >= 0 && ammo <= 5) {
                this.element.classList.add('fps-value-low');
            } else {
                this.element.classList.remove('fps-value-low');
            }
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


// =============================================================================
// Frag Counter — displays local player's score next to the timer
// =============================================================================

export class FPSFragCounter implements FPSHudWidget {
    private element: HTMLElement;
    private numberEl!: HTMLElement;
    private currentScore: number = -1;

    constructor() {
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'fps-frag-counter manga-panel';

        // Corner brackets
        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        wrapper.appendChild(corners);

        // Frag number
        this.numberEl = document.createElement('span');
        this.numberEl.className = 'fps-frag-number';
        this.numberEl.textContent = '0';
        wrapper.appendChild(this.numberEl);

        // Label
        const label = document.createElement('span');
        label.className = 'fps-frag-label';
        label.textContent = 'FRAGS';
        wrapper.appendChild(label);

        return wrapper;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        if (!state.localPlayerId) return;

        // Find local player in scoreboard
        const entry = state.scoreboard.find(e => e.playerId === state.localPlayerId);
        const score = entry ? entry.score : 0;

        if (score === this.currentScore) return;
        this.currentScore = score;
        this.numberEl.textContent = String(score);
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


// =============================================================================
// Phase 2: Weapon Rack
// =============================================================================

/**
 * All weapon IDs in slot order (matches number key bindings 1-9)
 */
const WEAPON_SLOTS: { id: string; slot: number; name: string }[] = [
    { id: 'gunblade', slot: 1, name: 'GB' },
    { id: 'machinegun', slot: 2, name: 'MG' },
    { id: 'riotgun', slot: 3, name: 'RG' },
    { id: 'glauncher', slot: 4, name: 'GL' },
    { id: 'rlauncher', slot: 5, name: 'RL' },
    { id: 'plasmagun', slot: 6, name: 'PG' },
    { id: 'lasergun', slot: 7, name: 'LG' },
    { id: 'electrobolt', slot: 8, name: 'EB' },
    { id: 'instagun', slot: 9, name: 'IG' },
];

/**
 * FPSWeaponRack - Vertical weapon inventory (left side)
 */
export class FPSWeaponRack implements FPSHudWidget {
    private element: HTMLElement;
    private slotEls: Map<string, HTMLElement> = new Map();
    private ammoEls: Map<string, HTMLElement> = new Map();
    private lastWeaponHash: string = '';

    constructor() {
        this.element = this.createElement();
    }

    private createElement(): HTMLElement {
        const rack = document.createElement('div');
        rack.className = 'fps-weapon-rack';

        for (const slot of WEAPON_SLOTS) {
            const el = document.createElement('div');
            el.className = 'fps-weapon-slot fps-weapon-slot--empty';

            const key = document.createElement('span');
            key.className = 'fps-weapon-slot-key';
            key.textContent = getActionKeyLabel(`fps_weapon_${slot.slot}`);

            const name = document.createElement('span');
            name.className = 'fps-weapon-slot-name';
            name.textContent = slot.name;

            const ammo = document.createElement('span');
            ammo.className = 'fps-weapon-slot-ammo';
            ammo.textContent = '';

            el.appendChild(key);
            el.appendChild(name);
            el.appendChild(ammo);

            rack.appendChild(el);
            this.slotEls.set(slot.id, el);
            this.ammoEls.set(slot.id, ammo);
        }

        return rack;
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(state: HUDState): void {
        const owned = state.weapons;
        const active = state.currentWeapon;
        const ammoMap = state.ammo;

        // Build a hash to detect changes
        const hash = `${active}|${owned.join(',')}|${JSON.stringify(ammoMap)}`;
        if (hash === this.lastWeaponHash) return;
        this.lastWeaponHash = hash;

        for (const slot of WEAPON_SLOTS) {
            const el = this.slotEls.get(slot.id);
            const ammoEl = this.ammoEls.get(slot.id);
            if (!el || !ammoEl) continue;

            const hasWeapon = owned.includes(slot.id);
            const isActive = active === slot.id;

            // Update classes
            el.classList.toggle('fps-weapon-slot--empty', !hasWeapon);
            el.classList.toggle('fps-weapon-slot--active', isActive);

            // Update ammo
            if (hasWeapon) {
                const ammoCount = ammoMap[slot.id];
                if (ammoCount === undefined || ammoCount < 0) {
                    ammoEl.textContent = '∞'; // Infinite (gunblade)
                } else {
                    ammoEl.textContent = String(ammoCount);
                }
            } else {
                ammoEl.textContent = '';
            }
        }
    }

    public show(): void {
        this.element.style.display = '';
    }

    public hide(): void {
        this.element.style.display = 'none';
    }

    public destroy(): void {
        this.slotEls.clear();
        this.ammoEls.clear();
        this.element.remove();
    }
}


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


// =============================================================================
// Phase 2: Pickup Toast
// =============================================================================

/**
 * FPSPickupToast - Shows pickup notifications (weapon, health, armor)
 * 
 * Call showPickup() externally when a pickup event occurs.
 * Messages auto-fade via CSS animation.
 */
export class FPSPickupToast implements FPSHudWidget {
    private element: HTMLElement;
    private lastWeapons: string[] = [];

    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'fps-toast-container';
        this.element.style.display = 'flex';
        this.element.style.flexDirection = 'column';
        this.element.style.alignItems = 'center';
        this.element.style.gap = '4px';
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    /**
     * Show a pickup notification
     */
    public showPickup(text: string): void {
        const toast = document.createElement('div');
        toast.className = 'fps-toast manga-panel';

        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        toast.appendChild(corners);

        const textEl = document.createElement('span');
        textEl.textContent = text;
        toast.appendChild(textEl);

        this.element.appendChild(toast);

        // Remove after animation (2s float-up)
        setTimeout(() => toast.remove(), 2100);
    }

    public update(state: HUDState): void {
        // Auto-detect weapon pickups by comparing weapon arrays
        const weapons = state.weapons;
        if (this.lastWeapons.length > 0 && weapons.length > this.lastWeapons.length) {
            // Find new weapons
            for (const wpn of weapons) {
                if (!this.lastWeapons.includes(wpn)) {
                    const slot = WEAPON_SLOTS.find(s => s.id === wpn);
                    const name = slot ? slot.name : wpn.toUpperCase();
                    this.showPickup(`Picked up ${name}`);
                }
            }
        }
        this.lastWeapons = [...weapons];
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


// =============================================================================
// Phase 3: Scoreboard
// =============================================================================

/**
 * FPSScoreboard - Tab-toggle scoreboard overlay
 *
 * Not a regular HudWidget — it's a full-screen overlay managed by FPSHud.
 * Call toggle() or show/hide to control visibility.
 */
export class FPSScoreboard {
    private overlay: HTMLElement;
    private bodyEl: HTMLElement;
    private titleEl: HTMLElement;
    private visible: boolean = false;
    private localPlayerId: string = '';

    constructor() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'fps-scoreboard-overlay';
        this.overlay.style.display = 'none';

        const board = document.createElement('div');
        board.className = 'fps-scoreboard manga-panel';

        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        board.appendChild(corners);

        this.titleEl = document.createElement('div');
        this.titleEl.className = 'fps-scoreboard-title';
        this.titleEl.textContent = 'SCOREBOARD';
        board.appendChild(this.titleEl);

        // Header
        const header = document.createElement('div');
        header.className = 'fps-scoreboard-header';
        header.innerHTML = `
            <span class="fps-scoreboard-col-name">Player</span>
            <span class="fps-scoreboard-col-score">Score</span>
            <span class="fps-scoreboard-col-deaths">Deaths</span>
            <span class="fps-scoreboard-col-ping">Ping</span>
        `;
        board.appendChild(header);

        this.bodyEl = document.createElement('div');
        this.bodyEl.className = 'fps-scoreboard-body';
        board.appendChild(this.bodyEl);

        this.overlay.appendChild(board);
        document.body.appendChild(this.overlay);
    }

    public setLocalPlayerId(id: string): void {
        this.localPlayerId = id;
    }

    public setTitle(title: string): void {
        this.titleEl.textContent = title;
    }

    public toggle(): void {
        if (this.visible) {
            this.hide();
        } else {
            this.show();
        }
    }

    public show(): void {
        this.visible = true;
        this.overlay.style.display = '';
        this.refresh();
    }

    public hide(): void {
        this.visible = false;
        this.overlay.style.display = 'none';
    }

    public isVisible(): boolean {
        return this.visible;
    }

    /**
     * Refresh the scoreboard rows from HUDState
     */
    public refresh(): void {
        if (!this.visible) return;

        const state = HUDState.getInstance();
        this.bodyEl.innerHTML = '';

        for (const entry of state.scoreboard) {
            const row = document.createElement('div');
            row.className = 'fps-scoreboard-row';
            if (entry.playerId === this.localPlayerId) {
                row.classList.add('fps-scoreboard-row--self');
            }

            row.innerHTML = `
                <span class="fps-scoreboard-col-name">${this.escapeHtml(entry.name)}</span>
                <span class="fps-scoreboard-col-score">${entry.score}</span>
                <span class="fps-scoreboard-col-deaths">${entry.deaths}</span>
                <span class="fps-scoreboard-col-ping">${entry.ping}ms</span>
            `;
            this.bodyEl.appendChild(row);
        }
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    public destroy(): void {
        this.overlay.remove();
    }
}


// =============================================================================
// Phase 3: Chat UI
// =============================================================================

interface ChatMessage {
    sender: string;
    text: string;
    timestamp: number;
}

/**
 * FPSChat - In-game chat with message log and input
 *
 * Messages auto-fade after a timeout. Input is shown by pressing T/Enter.
 * Not a regular HudWidget — managed separately.
 */
export class FPSChat {
    private container: HTMLElement;
    private logEl: HTMLElement;
    private inputWrap: HTMLElement;
    private inputEl: HTMLInputElement;
    private messages: ChatMessage[] = [];
    private inputActive: boolean = false;
    private onSendCallback: ((text: string) => void) | null = null;
    private static readonly MESSAGE_FADE_MS = 8000;
    private static readonly MAX_VISIBLE = 20;

    constructor() {
        this.container = document.createElement('div');
        this.container.className = 'fps-chat';

        // Message log
        this.logEl = document.createElement('div');
        this.logEl.className = 'fps-chat-log';
        this.container.appendChild(this.logEl);

        // Input area
        this.inputWrap = document.createElement('div');
        this.inputWrap.className = 'fps-chat-input-wrap';

        this.inputEl = document.createElement('input');
        this.inputEl.className = 'fps-chat-input';
        this.inputEl.type = 'text';
        this.inputEl.placeholder = 'Type a message...';
        this.inputEl.maxLength = 256;
        this.inputWrap.appendChild(this.inputEl);

        this.container.appendChild(this.inputWrap);
        document.body.appendChild(this.container);

        // Input event handlers
        this.inputEl.addEventListener('keydown', (e) => this.handleKey(e));
    }

    /**
     * Set callback for when a message is sent
     */
    public onSend(callback: (text: string) => void): void {
        this.onSendCallback = callback;
    }

    /**
     * Add a received message to the log
     */
    public addMessage(sender: string, text: string): void {
        const msg: ChatMessage = {
            sender,
            text,
            timestamp: performance.now(),
        };
        this.messages.push(msg);

        const el = document.createElement('div');
        el.className = 'fps-chat-message';

        const senderEl = document.createElement('span');
        senderEl.className = 'fps-chat-sender';
        senderEl.textContent = sender + ':';
        el.appendChild(senderEl);

        const textEl = document.createElement('span');
        textEl.textContent = text;
        el.appendChild(textEl);

        this.logEl.appendChild(el);

        // Auto-fade
        setTimeout(() => {
            el.classList.add('fps-chat-message--fading');
            setTimeout(() => el.remove(), 1000);
        }, FPSChat.MESSAGE_FADE_MS);

        // Trim excess
        while (this.logEl.children.length > FPSChat.MAX_VISIBLE) {
            this.logEl.firstChild?.remove();
        }
    }

    /**
     * Open the chat input
     */
    public openInput(): void {
        this.inputActive = true;
        this.inputWrap.classList.add('fps-chat-input-wrap--active');
        this.inputEl.value = '';
        this.inputEl.focus();
    }

    /**
     * Close the chat input
     */
    public closeInput(): void {
        this.inputActive = false;
        this.inputWrap.classList.remove('fps-chat-input-wrap--active');
        this.inputEl.blur();
    }

    public isInputActive(): boolean {
        return this.inputActive;
    }

    private handleKey(e: KeyboardEvent): void {
        if (e.key === 'Enter') {
            const text = this.inputEl.value.trim();
            if (text && this.onSendCallback) {
                this.onSendCallback(text);
            }
            this.closeInput();
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === 'Escape') {
            this.closeInput();
            e.preventDefault();
            e.stopPropagation();
        }
    }

    public destroy(): void {
        this.container.remove();
    }
}


// =============================================================================
// Phase 3: Damage Indicators
// =============================================================================

/**
 * FPSDamageIndicators - Directional damage arrows around crosshair
 *
 * Call showDamage(angleRadians) to display an indicator from a direction.
 * Arrows auto-fade via CSS animation.
 */
export class FPSDamageIndicators {
    private container: HTMLElement;

    constructor() {
        this.container = document.createElement('div');
        this.container.className = 'fps-damage-indicators';
        document.body.appendChild(this.container);
    }

    /**
     * Show a damage indicator from a direction
     * @param angleRad Angle in radians (0 = right, PI/2 = bottom, etc.)
     */
    public showDamage(angleRad: number): void {
        const arrow = document.createElement('div');
        arrow.className = 'fps-damage-arrow';

        // Position the arrow on the edge of the indicator circle
        const radius = 80; // Distance from center
        const deg = (angleRad * 180) / Math.PI;
        const x = Math.cos(angleRad) * radius;
        const y = Math.sin(angleRad) * radius;

        arrow.style.left = `calc(50% + ${x}px * var(--ui-scale, 1))`;
        arrow.style.top = `calc(50% + ${y}px * var(--ui-scale, 1))`;
        arrow.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;

        this.container.appendChild(arrow);

        // Remove after animation (0.6s)
        setTimeout(() => arrow.remove(), 650);
    }

    public destroy(): void {
        this.container.remove();
    }
}


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
            // Just died — show death screen
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
            // Respawned — hide death screen
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
class FPSPhaseMessage implements FPSHudWidget {
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




/**
 * FPSReadyBar - Ready status bar during warmup
 *
 * Shows ready count and F4 keybind. Only visible during Warmup phase.
 */
class FPSReadyBar implements FPSHudWidget {
    private element: HTMLElement;

    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'fps-ready-bar hidden';
        // Positioned independently from HUD zones
        document.body.appendChild(this.element);
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    public update(_state: HUDState): void {
        const mgr = MatchStateManager.getInstance();
        const controller = CameraSystem.getInstance()?.getActiveController();
        const isSpectating = controller?.type === 'freefly';

        if (mgr.isWarmup()) {
            this.element.classList.remove('hidden');

            if (isSpectating) {
                // Spectator mode: show "SPECTATING" (or player name when chasing)
                this.element.innerHTML = 'SPECTATING';
                this.element.classList.remove('fps-ready-bar--ready');
            } else {
                // Joined player: show ready counter and F4 prompt
                const readyText = mgr.isReady
                    ? '✓ Ready'
                    : `Press <span class="fps-ready-key">F4</span> when ready`;

                this.element.innerHTML = `${mgr.getReadyStatus()} — ${readyText}`;
                this.element.classList.toggle('fps-ready-bar--ready', mgr.isReady);
            }
        } else if (isSpectating) {
            // Outside warmup but spectating: still show "SPECTATING"
            this.element.classList.remove('hidden');
            this.element.innerHTML = 'SPECTATING';
            this.element.classList.remove('fps-ready-bar--ready');
        } else {
            this.element.classList.add('hidden');
        }
    }

    public show(): void { this.element.classList.remove('hidden'); }
    public hide(): void { this.element.classList.add('hidden'); }

    public destroy(): void {
        this.element.remove();
    }
}


/**
 * FPSGametypeBadge - Small gametype name in top-left
 */
class FPSGametypeBadge implements FPSHudWidget {
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

    constructor() {
        super('PAUSED', 'fps-pause-menu');

        // Hide header close button (use Resume instead)
        this.headerEl.style.display = 'none';

        // Hide footer
        this.footerEl.style.display = 'none';

        // Add menu buttons
        const resumeBtn = this.createButton('Resume', 'fps-btn--primary fps-btn--wide', () => {
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

        this.bodyEl.appendChild(resumeBtn);
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
}


// =============================================================================
// Phase 4: Settings Overlay
// =============================================================================

interface SettingsTab {
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
