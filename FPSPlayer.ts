// import { Scene } from "@babylonjs/core/scene";
// import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { FPSController } from "../../engine/camera/controllers/FPSController";
import { InventoryManager } from "../../engine/game/InventoryManager";
import { WeaponViewManager } from "../../engine/weapon/WeaponViewManager";
import { WeaponDef } from "../../shared/entities";
import { EntityManager } from "../../engine/entities/EntityManager";

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

    // Weapon State
    private isReloading: boolean = false;
    private reloadTimer: number = 0;
    private lastFireTime: number = 0;
    private fireReleased: boolean = true;
    private burstShotsRemaining: number = 0;

    constructor(controller: FPSController) {
        this.controller = controller;
        this.inventory = new InventoryManager();
        this.controller.setInventory(this.inventory);

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

        // Check for pickups
        // We use the controller's camera position for pickup checking
        const playerPos = this.controller.getPlayerPosition();
        // Note: getPlayerPosition returns origin level. 
        // Pickups usually check against feet or center? 
        // Original code used camera.position (eyes).
        // Let's us camera position if possible, or build it from physics pos
        // But since FPSController owns the camera, we can maybe access it? 
        // Actually FPSController exposes getPlayerPosition() which is consistent.

        // BETTER: Use the camera position from controller if available, strictly for "eye" based pickup?
        // Or just use the physics position.
        // Original code: EntityManager.getInstance().checkPickups(this.camera.position, this.inventory);
        // We'll trust that getPlayerPosition() is close enough or add an eye position getter if needed.
        // Actually, let's grab the feet position, pickups usually are on ground.
        // But original code used camera pos. Let's stick to what we have or expose camera pos?
        // FPSController has no public camera accessor? 
        // It has `getPlayerPosition()` (origin).
        EntityManager.getInstance().checkPickups(playerPos, this.inventory);

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

    private async switchWeapon(slotIndex: number): Promise<void> {
        const weaponId = this.inventory.getWeaponByIndex(slotIndex);
        if (!weaponId) return;

        if (this.inventory.getCurrentWeaponId() === weaponId) return;

        // Cancel reload
        this.isReloading = false;
        this.reloadTimer = 0;
        WeaponViewManager.getInstance().cancelReload();

        if (this.inventory.equipWeapon(weaponId)) {
            await WeaponViewManager.getInstance().loadWeapon(weaponId);
            console.log(`Switched to weapon: ${weaponId}`);
        }
    }

    private updateFiring(deltaTime: number): void {
        if (this.isReloading) return;

        const weaponMgr = WeaponViewManager.getInstance();
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
            return;
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

    private executeFire(mgr: WeaponViewManager): void {
        const weaponId = this.inventory.getCurrentWeaponId();
        if (!weaponId) return;

        if (this.inventory.consumeLoadedAmmo(weaponId, 1)) {
            mgr.fire();
            this.lastFireTime = performance.now() / 1000;

            // Notify controller/effects? 
            // Ideally we fire an event that the controller listens to for recoil?
            // For now, simple fire.
        }
    }

    public dispose(): void {
        this.controller.onWeaponSelect = null;
        this.controller.onReload = null;
        // this.inventory.dispose()? If it has one.
    }
}
