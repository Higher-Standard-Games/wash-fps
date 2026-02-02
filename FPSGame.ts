/**
 * FPSGame - Main FPS Game Class
 * 
 * This is the core game class that manages:
 * - Game initialization
 * - Scene setup
 * - HUD/UI systems
 * - Game state
 * - Player management
 */

import { Scene } from '@babylonjs/core';

export interface FPSGameConfig {
    /** Initial map to load (e.g., 'wdm1' or 'wda1') */
    initialMap?: string;
    /** Enable debug mode */
    debug?: boolean;
}

export class FPSGame {
    private _scene: Scene | null = null;
    private config: FPSGameConfig;
    private isInitialized = false;

    constructor(config: FPSGameConfig = {}) {
        this.config = {
            initialMap: 'wdm1',
            debug: false,
            ...config,
        };
    }

    /**
     * Initialize the FPS game
     */
    async init(scene: Scene): Promise<void> {
        this._scene = scene;

        console.log('[FPSGame] Initializing...');

        // TODO: Initialize game systems
        // - HUD system
        // - Weapon system
        // - Player spawning
        // - Scoreboard
        // - Match logic

        this.isInitialized = true;
        console.log('[FPSGame] Initialized');
    }

    /**
     * Update game logic (called each frame)
     */
    update(_deltaTime: number): void {
        if (!this.isInitialized) return;

        // TODO: Update game systems
        // - HUD updates
        // - Match timer
        // - Player stats
    }

    /**
     * Clean up resources
     */
    dispose(): void {
        console.log('[FPSGame] Disposing...');

        // TODO: Clean up game systems

        this._scene = null;
        this.isInitialized = false;
    }

    // =========================================================================
    // Getters
    // =========================================================================

    get initialized(): boolean {
        return this.isInitialized;
    }

    get currentConfig(): FPSGameConfig {
        return { ...this.config };
    }

    get scene(): Scene | null {
        return this._scene;
    }
}
