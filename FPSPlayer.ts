// import { Scene } from "@babylonjs/core/scene";
// import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { FPSController } from "../../engine/camera/controllers/FPSController";
import { InventoryManager } from "../../engine/game/InventoryManager";
import { Pickup } from "../../engine/game/Pickup";
import { WeaponViewManager } from "../../engine/weapon/WeaponViewManager";
import { WeaponDef } from "../../shared/entities";
import { Color3 } from "@babylonjs/core/Maths/math.color";

/**
 * FPSPlayer - High-level game entity for FPS mode
 * 
 * Owns the controller (movement), inventory, and weapon logic.
 * Decouples game-specific mechanics from the generic engine camera controller.
 */
export class FPSPlayer {
    public inventory: InventoryManager;
    private controller: FPSController;
    // private scene: Scene;

    // Static instance for access from Game
    private static _instance: FPSPlayer | null = null;
    static getInstance(): FPSPlayer | null { return FPSPlayer._instance; }
    public getController(): FPSController { return this.controller; }

    // Weapon State
    private isReloading: boolean = false;
    private reloadTimer: number = 0;
    private lastFireTime: number = 0;
    private fireReleased: boolean = true;
    private burstShotsRemaining: number = 0;
    private _serverLastFireTick: number = 0;  // track server fire tick for drift correction

    // Beam charge state
    private static readonly BEAM_CHARGE_TIME = 0.25;  // 250ms charge in hipfire
    private beamChargeTimer: number = 0;
    private beamCharged: boolean = false;

    constructor(controller: FPSController) {
        this.controller = controller;
        this.inventory = new InventoryManager();
        this.controller.setInventory(this.inventory);
        FPSPlayer._instance = this;

        this.setupControllerEvents();
    }

    private setupControllerEvents(): void {
        // Listen for weapon switch keys (1-9)
        this.controller.onWeaponSelect = (index: number) => {
            this.switchWeapon(index);
        };

        // Listen for reload key (R)
        this.controller.onReload = () => {
            this.checkReload();
        };

        // Listen for use/interact key (F) — weapon pickup
        this.controller.onUse = () => {
            Pickup.triggerUseAction();
        };

        // Block weapon switching input during animation (prevents scroll stutter)
        this.controller.setWeaponSwitchBlockedCheck(() => {
            return WeaponViewManager.getInstance().isSwitching();
        });
    }

    public update(deltaTime: number): void {
        if (!this.controller.isEnabled()) return;

        // Handle reloading timer
        if (this.isReloading) {
            this.reloadTimer -= deltaTime;
            if (this.reloadTimer <= 0) {
                this.finishReload();
            }
            // If reloading, we might block firing. 
            // Current logic: return early from firing check if reloading
        }

        // Pickup checking is now server-authoritative (PickupSystem.ts)
        // Client-side Pickup.ts is display-only, no inventory changes needed here

        // Update Firing Logic
        this.updateFiring(deltaTime);
    }

    private checkReload(): void {
        const currentWeapon = this.inventory.getCurrentWeapon();
        const currentId = this.inventory.getCurrentWeaponId();
        if (!currentWeapon || !currentId) return;

        if (this.inventory.needsReload(currentId)) {
            this.startReload(currentWeapon, currentId);
        }
    }

    private startReload(weapon: WeaponDef, weaponId: string): void {
        if (this.isReloading) return;

        // Peek if reload is possible
        const clipSize = weapon.clipSize || 0;
        if (clipSize <= 0) return; // No clip

        const loaded = this.inventory.getLoadedAmmo(weaponId);
        if (loaded >= clipSize) return; // Full

        if (weapon.ammoType && this.inventory.getAmmoCount(weapon.ammoType) <= 0) {
            // No reserve ammo
            return;
        }

        this.isReloading = true;
        this.reloadTimer = weapon.reloadTime || 0.6;
        console.log(`Reloading... (${this.reloadTimer}s)`);

        WeaponViewManager.getInstance().startReload(weapon.reloadTime || 0.6);
    }

    private finishReload(): void {
        this.isReloading = false;
        const currentId = this.inventory.getCurrentWeaponId();
        if (currentId) {
            if (this.inventory.reloadWeapon(currentId)) {
                console.log("Reload complete.");
            } else {
                console.log("Reload failed.");
            }
        }
    }

    private switchWeapon(slotIndex: number): void {
        const weaponId = this.inventory.getWeaponByIndex(slotIndex);
        if (!weaponId) return;

        if (this.inventory.getCurrentWeaponId() === weaponId) return;

        // Cancel reload
        this.isReloading = false;
        this.reloadTimer = 0;

        // Play animated switch immediately for responsiveness (client prediction).
        // Don't call equipWeapon() — let the server confirm the switch via weapon_state,
        // which will update currentWeaponId in syncFromServer().
        // Animation blocking is handled by setWeaponSwitchBlockedCheck callback.
        WeaponViewManager.getInstance().switchWeaponAnimated(weaponId);
        console.log(`Switching to weapon: ${weaponId}`);
    }

    private updateFiring(_deltaTime: number): void {
        if (this.isReloading) return;

        // Block firing during weapon switch animation
        const weaponMgr = WeaponViewManager.getInstance();
        if (weaponMgr.isSwitching()) return;
        const currentWeapon = this.inventory.getCurrentWeapon();
        if (!currentWeapon) return;

        const fireRate = currentWeapon.fireRate ?? 10;
        const fireDelay = 1.0 / fireRate;
        const now = performance.now() / 1000;

        // Burst Logic
        if (this.burstShotsRemaining > 0 && (now - this.lastFireTime) >= fireDelay) {
            this.executeFire(weaponMgr);
            this.burstShotsRemaining--;
            return;
        }

        // Input check from Controller
        if (!this.controller.isFiring()) {
            this.fireReleased = true;
            // Stop continuous beam and reset charge when fire is released
            if (currentWeapon.hitscanType === 'beam') {
                if (this.beamCharged || this.beamChargeTimer > 0) {
                    WeaponViewManager.getInstance().setBeamActive(false);
                }
                this.beamChargeTimer = 0;
                this.beamCharged = false;
            }
            return;
        }

        // Beam charge-up / activation
        if (currentWeapon.hitscanType === 'beam') {
            const wvm = WeaponViewManager.getInstance();
            const mfColor = currentWeapon.muzzleFlash?.color;
            const color = mfColor
                ? new Color3(mfColor.r, mfColor.g, mfColor.b)
                : new Color3(1.0, 0.7, 0.1);

            if (this.controller.isAiming()) {
                // ADS: fire immediately, no charge needed
                this.beamCharged = true;
                this.beamChargeTimer = FPSPlayer.BEAM_CHARGE_TIME;
                wvm.setBeamActive(true, color);
            } else if (!this.beamCharged) {
                // Hipfire: charge up 250ms before beam fires
                this.beamChargeTimer += _deltaTime;
                const progress = Math.min(1, this.beamChargeTimer / FPSPlayer.BEAM_CHARGE_TIME);
                wvm.setBeamCharging(progress);
                if (this.beamChargeTimer >= FPSPlayer.BEAM_CHARGE_TIME) {
                    this.beamCharged = true;
                    wvm.setBeamActive(true, color);
                }
            } else {
                // Already charged — keep beam active
                wvm.setBeamActive(true, color);
            }
        }

        // Cooldown check
        if ((now - this.lastFireTime) < fireDelay) return;

        // Fire Modes
        const mode = currentWeapon.fireMode ?? 'auto';
        let readyToFire = false;

        if (mode === 'auto') {
            readyToFire = true;
        } else if (mode === 'semi') {
            if (this.fireReleased) {
                readyToFire = true;
                this.fireReleased = false;
            }
        } else if (mode === 'burst') {
            if (this.fireReleased && this.burstShotsRemaining === 0) {
                readyToFire = true;
                this.fireReleased = false;
                const burstCount = currentWeapon.burstCount ?? 3;
                this.burstShotsRemaining = burstCount - 1;
            }
        }

        if (readyToFire) {
            // Auto-reload check
            const weaponId = this.inventory.getCurrentWeaponId();
            if (weaponId && this.inventory.getLoadedAmmo(weaponId) <= 0 && currentWeapon.clipSize > 0) {
                this.startReload(currentWeapon, weaponId);
            } else {
                this.executeFire(weaponMgr);
            }
        }
    }

    private executeFire(_mgr: WeaponViewManager): void {
        // Don't predict fire effects locally — they are triggered by server's weapon_fire event.
        // We only track cooldown timing here to prevent spamming the server with rapid inputs.
        this.lastFireTime = performance.now() / 1000;
    }

    /**
     * Sync reload state from server — if server is still reloading,
     * block client-side firing to prevent ghost shots.
     */
    public setServerReloadState(reloading: boolean): void {
        if (reloading && !this.isReloading) {
            // Server is reloading but client isn't — force client into reload state
            this.isReloading = true;
        } else if (!reloading && this.isReloading) {
            // Server finished reloading — allow client to fire again
            this.isReloading = false;
            this.reloadTimer = 0;
        }
    }

    /**
     * Sync fire timing from server tick — if the server's lastFireTick
     * is newer than what the client expects, push lastFireTime forward
     * so the client's cooldown matches the server's.
     */
    public syncFireTiming(serverLastFireTick: number): void {
        if (serverLastFireTick > this._serverLastFireTick) {
            this._serverLastFireTick = serverLastFireTick;
            // Convert server tick to approximate wall-clock time
            // Server runs at 125 ticks/sec
            const serverFireAge = 0; // Just fired — reset cooldown
            const now = performance.now() / 1000;
            this.lastFireTime = Math.max(this.lastFireTime, now - serverFireAge);
        }
    }

    public dispose(): void {
        this.controller.onWeaponSelect = null;
        this.controller.onReload = null;
        this.controller.onUse = null;
        if (FPSPlayer._instance === this) FPSPlayer._instance = null;
        // this.inventory.dispose()? If it has one.
    }
}
