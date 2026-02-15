/**
 * MatchHUD — Match lifecycle overlay
 * 
 * DOM-based HUD overlay showing:
 * - Center message: phase-dependent announcements
 * - Timer: countdown during Active phase
 * - Ready status: during Warmup
 * 
 * Self-contained CSS, no dependency on HUDManager config system.
 */

import { MatchStateManager, MatchPhase } from './MatchStateManager';

// ============================================================================
// Styles
// ============================================================================

const MATCH_HUD_CSS = `
.match-hud {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 900;
    font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
}

/* Center message (Warmup, Countdown, Fight, Match Over) */
.match-hud__center {
    position: absolute;
    top: 30%;
    left: 50%;
    transform: translateX(-50%);
    text-align: center;
    transition: opacity 0.4s ease-out, transform 0.4s ease-out;
}

.match-hud__center.hidden {
    opacity: 0;
    transform: translateX(-50%) scale(0.9);
    pointer-events: none;
}

.match-hud__phase {
    font-size: 36px;
    font-weight: 700;
    color: #fff;
    text-shadow: 0 2px 12px rgba(0, 0, 0, 0.7), 0 0 40px rgba(255, 160, 0, 0.3);
    letter-spacing: 2px;
    text-transform: uppercase;
    margin-bottom: 8px;
}

.match-hud__subtitle {
    font-size: 16px;
    font-weight: 400;
    color: rgba(255, 255, 255, 0.7);
    text-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
}

/* Countdown number */
.match-hud__countdown {
    font-size: 120px;
    font-weight: 900;
    color: #fff;
    text-shadow: 0 4px 20px rgba(255, 120, 0, 0.6), 0 0 60px rgba(255, 80, 0, 0.4);
    animation: countdown-pulse 1s ease-out;
    line-height: 1;
}

@keyframes countdown-pulse {
    0% { transform: scale(1.5); opacity: 0.5; }
    30% { transform: scale(1.0); opacity: 1; }
    100% { transform: scale(1.0); opacity: 1; }
}

/* FIGHT flash */
.match-hud__fight {
    font-size: 72px;
    font-weight: 900;
    color: #ff6600;
    text-shadow: 0 4px 30px rgba(255, 100, 0, 0.8), 0 0 80px rgba(255, 60, 0, 0.5);
    animation: fight-flash 0.6s ease-out;
    text-transform: uppercase;
    letter-spacing: 8px;
}

@keyframes fight-flash {
    0% { transform: scale(2.0); opacity: 0; }
    30% { transform: scale(1.0); opacity: 1; }
    100% { transform: scale(1.0); opacity: 1; }
}

/* Timer (top center) */
.match-hud__timer {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 20px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.6);
    font-variant-numeric: tabular-nums;
    transition: opacity 0.3s;
}

.match-hud__timer.hidden {
    opacity: 0;
}

.match-hud__timer.warning {
    color: #ff4444;
    animation: timer-blink 1s infinite;
}

@keyframes timer-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}

/* Ready status pill */
.match-hud__ready {
    position: absolute;
    bottom: 120px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 20px;
    padding: 8px 24px;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.8);
    backdrop-filter: blur(8px);
    transition: opacity 0.3s;
}

.match-hud__ready.hidden {
    opacity: 0;
}

.match-hud__ready-key {
    color: #ffaa00;
    font-weight: 600;
}

/* Gametype badge (top-left) */
.match-hud__gametype {
    position: absolute;
    top: 16px;
    left: 16px;
    font-size: 12px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.5);
    text-transform: uppercase;
    letter-spacing: 1px;
}
`;

// ============================================================================
// MatchHUD Class
// ============================================================================

export class MatchHUD {
    private static instance: MatchHUD | null = null;

    private container: HTMLDivElement | null = null;
    private centerEl: HTMLDivElement | null = null;
    private timerEl: HTMLDivElement | null = null;
    private readyEl: HTMLDivElement | null = null;
    private gametypeEl: HTMLDivElement | null = null;
    private styleEl: HTMLStyleElement | null = null;
    private updateInterval: ReturnType<typeof setInterval> | null = null;
    private centerHideTimeout: ReturnType<typeof setTimeout> | null = null;
    private lastCountdown: number = 0;

    private unsubPhase: (() => void) | null = null;

    static getInstance(): MatchHUD {
        if (!MatchHUD.instance) {
            MatchHUD.instance = new MatchHUD();
        }
        return MatchHUD.instance;
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    init(): void {
        if (this.container) return; // Already initialized

        // Inject CSS
        this.styleEl = document.createElement('style');
        this.styleEl.textContent = MATCH_HUD_CSS;
        document.head.appendChild(this.styleEl);

        // Create DOM
        this.container = document.createElement('div');
        this.container.className = 'match-hud';

        // Center message
        this.centerEl = document.createElement('div');
        this.centerEl.className = 'match-hud__center';
        this.container.appendChild(this.centerEl);

        // Timer
        this.timerEl = document.createElement('div');
        this.timerEl.className = 'match-hud__timer hidden';
        this.container.appendChild(this.timerEl);

        // Ready status
        this.readyEl = document.createElement('div');
        this.readyEl.className = 'match-hud__ready hidden';
        this.container.appendChild(this.readyEl);

        // Gametype badge
        this.gametypeEl = document.createElement('div');
        this.gametypeEl.className = 'match-hud__gametype';
        this.container.appendChild(this.gametypeEl);

        document.body.appendChild(this.container);

        // Subscribe to phase changes
        const mgr = MatchStateManager.getInstance();
        this.unsubPhase = mgr.onPhaseChange((newPhase, oldPhase) => {
            this.onPhaseChange(newPhase, oldPhase);
        });

        // Start update loop (10Hz is enough for HUD)
        this.updateInterval = setInterval(() => this.update(), 100);

        // Initial render
        this.update();

        console.log('[MatchHUD] Initialized');
    }

    destroy(): void {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        if (this.centerHideTimeout) {
            clearTimeout(this.centerHideTimeout);
            this.centerHideTimeout = null;
        }
        if (this.unsubPhase) {
            this.unsubPhase();
            this.unsubPhase = null;
        }
        if (this.container) {
            this.container.remove();
            this.container = null;
        }
        if (this.styleEl) {
            this.styleEl.remove();
            this.styleEl = null;
        }

        MatchHUD.instance = null;
        console.log('[MatchHUD] Destroyed');
    }

    // ========================================================================
    // Update Loop
    // ========================================================================

    private update(): void {
        const mgr = MatchStateManager.getInstance();

        // Gametype badge
        if (this.gametypeEl) {
            this.gametypeEl.textContent = mgr.gametypeName || '';
        }

        // Timer
        if (this.timerEl) {
            if (mgr.isActive()) {
                this.timerEl.classList.remove('hidden');
                this.timerEl.textContent = mgr.getTimeString();
                // Warning when < 30 seconds
                if (mgr.timeRemaining < 30) {
                    this.timerEl.classList.add('warning');
                } else {
                    this.timerEl.classList.remove('warning');
                }
            } else if (mgr.isCountdown()) {
                this.timerEl.classList.remove('hidden');
                this.timerEl.textContent = mgr.getTimeString();
                this.timerEl.classList.remove('warning');
            } else {
                this.timerEl.classList.add('hidden');
            }
        }

        // Ready status (only during warmup)
        if (this.readyEl) {
            if (mgr.isWarmup()) {
                this.readyEl.classList.remove('hidden');
                const readyText = mgr.isReady ? '✓ Ready' : `Press <span class="match-hud__ready-key">F4</span> when ready`;
                this.readyEl.innerHTML = `${mgr.getReadyStatus()} — ${readyText}`;
            } else {
                this.readyEl.classList.add('hidden');
            }
        }

        // Countdown number update (re-triggers animation)
        if (mgr.isCountdown() && this.centerEl) {
            const num = mgr.getCountdownNumber();
            if (num !== this.lastCountdown && num > 0) {
                this.lastCountdown = num;
                this.showCenter(`<div class="match-hud__countdown">${num}</div>`);
            }
        }

        // Warmup center message (persistent)
        if (mgr.isWarmup() && this.centerEl) {
            this.showCenter(
                `<div class="match-hud__phase">Warmup</div>` +
                `<div class="match-hud__subtitle">${mgr.gametypeName}</div>`
            );
        }
    }

    // ========================================================================
    // Phase Change Handler
    // ========================================================================

    private onPhaseChange(newPhase: MatchPhase, _oldPhase: MatchPhase): void {
        // Clear any pending hide timeout
        if (this.centerHideTimeout) {
            clearTimeout(this.centerHideTimeout);
            this.centerHideTimeout = null;
        }

        switch (newPhase) {
            case MatchPhase.Warmup:
                // Will be handled by update()
                this.lastCountdown = 0;
                break;

            case MatchPhase.Countdown:
                this.lastCountdown = 0; // Reset so first number triggers
                break;

            case MatchPhase.Active:
                // Show FIGHT! then hide after 2 seconds
                this.showCenter(`<div class="match-hud__fight">Fight!</div>`);
                this.centerHideTimeout = setTimeout(() => {
                    this.hideCenter();
                }, 2000);
                break;

            case MatchPhase.PostGame:
                this.showCenter(
                    `<div class="match-hud__phase">Match Over</div>` +
                    `<div class="match-hud__subtitle">Next match starting soon...</div>`
                );
                break;
        }
    }

    // ========================================================================
    // DOM Helpers
    // ========================================================================

    private showCenter(html: string): void {
        if (!this.centerEl) return;
        this.centerEl.innerHTML = html;
        this.centerEl.classList.remove('hidden');
    }

    private hideCenter(): void {
        if (!this.centerEl) return;
        this.centerEl.classList.add('hidden');
    }
}
