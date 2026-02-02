/**
 * FPS Server Game
 * Main game class for FPS mode
 */

import { Simulation } from '@engine/server/core/Simulation';
import { FPSPhysicsSystem } from './systems/FPSPhysicsSystem';
import { Deathmatch } from './gametypes/Deathmatch';
import type { BaseGametype } from './gametypes/BaseGametype';
import { FPS_TICK_CONFIG } from '@engine/server/tick/TickConfig';
import type { TickConfig } from '@engine/server/tick/TickConfig';

export interface FPSServerGameConfig {
    /** Gametype to use */
    gametype: BaseGametype;

    /** Map name */
    map: string;
}

const DEFAULT_CONFIG: FPSServerGameConfig = {
    gametype: new Deathmatch(),
    map: 'wdm14',
};

export class FPSServerGame {
    private config: FPSServerGameConfig;
    private simulation: Simulation;

    constructor(config: Partial<FPSServerGameConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.simulation = new Simulation({
            tickMs: 1000 / FPS_TICK_CONFIG.physics,
        });

        this.setupSubsystems();
    }

    private setupSubsystems(): void {
        // Add physics system
        this.simulation.addSubsystem(new FPSPhysicsSystem());

        // TODO: Add more systems
        // this.simulation.addSubsystem(new FPSCombatSystem());
        // this.simulation.addSubsystem(new FPSWeaponSystem());
    }

    /**
     * Get simulation
     */
    getSimulation(): Simulation {
        return this.simulation;
    }

    /**
     * Get gametype
     */
    getGametype(): BaseGametype {
        return this.config.gametype;
    }

    /**
     * Get tick config
     */
    getTickConfig(): TickConfig {
        return FPS_TICK_CONFIG;
    }

    /**
     * Get map name
     */
    getMap(): string {
        return this.config.map;
    }
}
