/**
 * InventoryManager - Manages player weapons and ammunition
 */

import { EntityRegistry } from "../../../shared/entities/EntityRegistry";
import { EntityType } from "../../../shared/entities/EntityType";
import type { WeaponDef } from "../../../shared/entities/WeaponDef";
import { devLog } from "../client/DevLog";

export interface AmmoState {
  [ammoType: string]: number;
}

export interface WeaponAmmoState {
  clip: number;
  reserve: number;
}

export type ServerAmmoState = number | WeaponAmmoState;

export class InventoryManager {
  private weapons: Map<string, WeaponDef> = new Map();
  private slots: string[] = [];
  private ammo: AmmoState = {};
  private currentWeaponId: string | null = null;

  // Limits
  private static readonly MAX_AMMO = 200; // Default fallback
  public static readonly MAX_WEAPONS = 3; // COD-style: blade + 2 pickable

  constructor() {
    // Initialize with default ammo types (optional)
    this.ammo = {
      shells: 0,
      bullets: 0,
      rockets: 0,
      cells: 0,
      slugs: 0,
      grenades: 0,
    };
  }

  /**
   * Give a weapon to the player.
   * If at MAX_WEAPONS capacity, drops the currently equipped weapon.
   * @returns { acquired: boolean, dropped: WeaponDef | null }
   */
  public giveWeapon(weaponId: string): { acquired: boolean; dropped: WeaponDef | null } {
    if (this.weapons.has(weaponId)) {
      return { acquired: false, dropped: null };
    }

    const def = EntityRegistry.getInstance().get<WeaponDef>(weaponId);
    if (!def || def.type !== EntityType.WEAPON) {
      console.warn(`[InventoryManager] Invalid weapon ID: ${weaponId}`);
      return { acquired: false, dropped: null };
    }

    let dropped: WeaponDef | null = null;

    // At capacity? Drop the active weapon first
    if (this.slots.length >= InventoryManager.MAX_WEAPONS) {
      const activeId = this.currentWeaponId;
      if (activeId) {
        dropped = this.dropWeapon(activeId);
      } else {
        // No active weapon — drop the last slot
        dropped = this.dropWeapon(this.slots[this.slots.length - 1]);
      }
    }

    this.weapons.set(weaponId, def);
    this.slots.push(weaponId);
    devLog(
      `[InventoryManager] Acquired weapon: ${def.name} (Slot ${this.slots.length}/${InventoryManager.MAX_WEAPONS})`,
    );

    // Auto-equip new weapon
    this.equipWeapon(weaponId);

    return { acquired: true, dropped };
  }

  /**
   * Give ammo to the player
   * @returns amount actually added
   */
  public giveAmmo(ammoType: string, amount: number): number {
    const current = this.ammo[ammoType] || 0;
    // Reserve is keyed by weapon id; other keys use the shared fallback cap.
    const def = EntityRegistry.getInstance().get<WeaponDef>(ammoType);
    const max = def?.type === EntityType.WEAPON && def.maxAmmo > 0 ? def.maxAmmo : InventoryManager.MAX_AMMO;

    const added = Math.min(amount, max - current);
    this.ammo[ammoType] = current + added;

    return added;
  }

  /**
   * Sync inventory from server-authoritative weapon_state event.
   * Adds missing weapons, removes stale weapons, syncs ammo and current weapon.
   * @returns whether currentWeapon changed (needs model load)
   */
  public syncFromServer(
    serverWeapons: string[],
    serverAmmo: Record<string, ServerAmmoState>,
    serverCurrentWeapon: string,
  ): boolean {
    // Capture previous weapon BEFORE any mutations
    const previousWeaponId = this.currentWeaponId;

    // Remove weapons the server no longer has
    const clientWeapons = [...this.slots];
    for (const weaponId of clientWeapons) {
      if (!serverWeapons.includes(weaponId)) {
        this.dropWeapon(weaponId);
      }
    }

    // Add weapons we don't have — use direct add instead of giveWeapon()
    // to avoid client-side drop logic (server already handles drops)
    for (const weaponId of serverWeapons) {
      if (!this.weapons.has(weaponId)) {
        const def = EntityRegistry.getInstance().get<WeaponDef>(weaponId);
        if (def && def.type === EntityType.WEAPON) {
          this.weapons.set(weaponId, def);
          this.slots.push(weaponId);
        }
      }
    }

    // Reorder slots to match server order
    this.slots = serverWeapons.filter((w) => this.weapons.has(w));

    // Sync ammo — server sends ammo keyed by weaponId, but client reserve uses ammoType
    for (const [weaponId, rawAmmo] of Object.entries(serverAmmo)) {
      const def = this.weapons.get(weaponId);
      const ammo = this.normalizeServerAmmo(rawAmmo, def);
      // Set by weaponId directly (for HUD display compatibility)
      this.setAmmo(weaponId, ammo.clip + ammo.reserve);

      // Also set by ammoType: getLoadedAmmo reads a pool weapon's count from here
      if (def?.ammoType) {
        this.setAmmo(def.ammoType, def.reloadModel === "clip" ? ammo.reserve : ammo.clip);
      }

      // Sync loaded ammo (clip) — if server says we have ammo, ensure clip is loaded
      if (def) {
        this.ensureWeaponState(weaponId, def.clipSize);
        const state = this.weaponStates.get(weaponId);
        if (state) {
          // Server has ammo but client clip is empty — refill clip
          state.loadedAmmo = ammo.clip;
        }
      }
    }

    // Always set current weapon from server (authoritative)
    // Don't guard on weapons.has() — that caused infinite animation loops
    // when the weapon def wasn't in the local map yet
    this.currentWeaponId = serverCurrentWeapon;

    // Compare against PREVIOUS weapon to detect changes
    return previousWeaponId !== serverCurrentWeapon;
  }

  /**
   * Drop a weapon — removes it from inventory and returns its def
   * for re-spawning as a world pickup.
   */
  public dropWeapon(weaponId: string): WeaponDef | null {
    const def = this.weapons.get(weaponId);
    if (!def) return null;

    this.weapons.delete(weaponId);
    this.slots = this.slots.filter((id) => id !== weaponId);
    this.weaponStates.delete(weaponId);

    // If we dropped the active weapon, switch to whatever's left
    if (this.currentWeaponId === weaponId) {
      this.currentWeaponId = this.slots.length > 0 ? this.slots[0] : null;
      if (this.currentWeaponId) {
        devLog(`[InventoryManager] Auto-switched to: ${this.weapons.get(this.currentWeaponId)?.name}`);
      }
    }

    devLog(`[InventoryManager] Dropped weapon: ${def.name}`);
    return def;
  }

  /**
   * Equip a weapon
   */
  public equipWeapon(weaponId: string): boolean {
    if (!this.weapons.has(weaponId)) {
      console.warn(`[InventoryManager] Player does not have weapon: ${weaponId}`);
      return false;
    }

    // The caller loads the view model (WeaponViewManager); the inventory only tracks state.
    this.currentWeaponId = weaponId;
    devLog(`[InventoryManager] Equipped: ${this.weapons.get(weaponId)?.name}`);
    return true;
  }

  // Track run-time state for weapons (e.g. loaded ammo)
  private weaponStates: Map<string, { loadedAmmo: number }> = new Map();

  private ensureWeaponState(weaponId: string, clipSize: number) {
    if (!this.weaponStates.has(weaponId)) {
      this.weaponStates.set(weaponId, { loadedAmmo: clipSize });
    }
  }

  private normalizeServerAmmo(raw: ServerAmmoState, def?: WeaponDef): WeaponAmmoState {
    if (typeof raw === "object" && raw !== null) {
      return { clip: Math.max(0, raw.clip ?? 0), reserve: Math.max(0, raw.reserve ?? 0) };
    }

    const total = Math.max(0, raw ?? 0);
    if (!def) return { clip: total, reserve: 0 };
    if (def.reloadModel === "clip") {
      const clip = Math.min(def.clipSize, total);
      return { clip, reserve: Math.max(0, total - clip) };
    }
    if (def.reloadModel === "none") {
      return { clip: def.maxAmmo || 1, reserve: 0 };
    }
    return { clip: total, reserve: 0 };
  }

  /**
   * Get loaded ammo for a weapon
   */
  public getLoadedAmmo(weaponId: string): number {
    const def = this.weapons.get(weaponId);
    if (!def) return 0;

    if (def.reloadModel === "none") return Number.MAX_SAFE_INTEGER;
    if (def.reloadModel !== "clip") return this.getAmmoCount(def.ammoType || "");

    this.ensureWeaponState(weaponId, def.clipSize);
    return this.weaponStates.get(weaponId)!.loadedAmmo;
  }

  public getWeaponByIndex(index: number): string | undefined {
    if (index < 0 || index >= this.slots.length) return undefined;
    return this.slots[index];
  }

  /**
   * Check if weapon needs reload
   */
  public needsReload(weaponId: string): boolean {
    const def = this.weapons.get(weaponId);
    if (def?.reloadModel !== "clip" || !def.clipSize) return false;

    this.ensureWeaponState(weaponId, def.clipSize);
    const state = this.weaponStates.get(weaponId)!;

    // Can reload if not full AND has reserve
    return state.loadedAmmo < def.clipSize && (def.ammoType ? this.getAmmoCount(def.ammoType) > 0 : true);
  }

  public hasWeapon(weaponId: string): boolean {
    return this.weapons.has(weaponId);
  }

  public getCurrentWeapon(): WeaponDef | undefined {
    if (!this.currentWeaponId) return undefined;
    return this.weapons.get(this.currentWeaponId);
  }

  public getCurrentWeaponId(): string | null {
    return this.currentWeaponId;
  }

  /**
   * Get all weapon IDs in slot order
   */
  public getWeapons(): string[] {
    return [...this.slots];
  }

  /**
   * Get number of occupied weapon slots
   */
  public getSlotCount(): number {
    return this.slots.length;
  }

  public getAmmoCount(ammoType: string): number {
    return this.ammo[ammoType] || 0;
  }

  /**
   * Set ammo count directly (used for server state sync)
   */
  public setAmmo(ammoType: string, amount: number): void {
    this.ammo[ammoType] = amount;
  }

  // Directly consumes reserve ammo
}
