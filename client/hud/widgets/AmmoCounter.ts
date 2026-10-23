// Extracted from FPSHud.ts
import { WEAPONS } from "../../../shared/entities/definitions/weapons/WeaponsTable";
import type { FPSHudWidget, HUDState } from "../HudWidget";
import { restartFlash } from "../restartFlash";

const FLASH_CLASSES = ["fps-flash-loss"] as const;
const FLASH_NAMES = ["fps-flash-loss"] as const;

/**
 * FPSAmmoCounter - Ammo count + weapon name display
 */
export class FPSAmmoCounter implements FPSHudWidget {
  private element: HTMLElement;
  private numberEl!: HTMLElement;
  private reserveEl!: HTMLElement;
  private weaponEl!: HTMLElement;
  private fillEl!: HTMLElement;
  private currentAmmo: string = "";
  private currentPrimaryAmmo: number = -1;
  private currentWeapon: string = "";

  constructor() {
    this.element = this.createElement();
  }

  private createElement(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "fps-ammo-counter manga-panel manga-panel--gold";

    const corners = document.createElement("div");
    corners.className = "manga-panel-corners";
    wrapper.appendChild(corners);

    const icon = document.createElement("div");
    icon.className = "fps-value-bar-icon";
    icon.textContent = "AM";
    wrapper.appendChild(icon);

    const content = document.createElement("div");
    content.className = "fps-value-bar-content";
    wrapper.appendChild(content);

    const top = document.createElement("div");
    top.className = "fps-value-bar-top fps-ammo-readout";
    content.appendChild(top);

    this.numberEl = document.createElement("div");
    this.numberEl.className = "fps-ammo-number";
    this.numberEl.textContent = "--";
    top.appendChild(this.numberEl);

    this.reserveEl = document.createElement("div");
    this.reserveEl.className = "fps-ammo-reserve";
    this.reserveEl.textContent = "";
    this.reserveEl.style.display = "none";
    top.appendChild(this.reserveEl);

    this.weaponEl = document.createElement("div");
    this.weaponEl.className = "fps-ammo-weapon";
    this.weaponEl.textContent = "";
    content.appendChild(this.weaponEl);

    const track = document.createElement("div");
    track.className = "fps-value-bar-track";
    content.appendChild(track);

    this.fillEl = document.createElement("div");
    this.fillEl.className = "fps-value-bar-fill";
    this.fillEl.style.width = "100%";
    track.appendChild(this.fillEl);

    return wrapper;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(state: HUDState): void {
    const weapon = state.currentWeapon;
    const ammo = state.ammo[weapon] ?? -1;
    const def = WEAPONS[weapon];
    const structuredAmmo = typeof ammo === "object" && ammo !== null ? ammo : null;
    const usesReserve = structuredAmmo !== null && def?.reloadModel === "clip";
    const primaryAmmo: number = structuredAmmo ? structuredAmmo.clip : (ammo as number);
    const reserveAmmo = usesReserve ? structuredAmmo.reserve : null;
    const ammoKey = `${primaryAmmo}:${reserveAmmo ?? ""}`;

    if (weapon !== this.currentWeapon) {
      this.currentWeapon = weapon;
      this.weaponEl.textContent = weapon.toUpperCase();
    }

    if (ammoKey !== this.currentAmmo) {
      const oldAmmo = this.currentPrimaryAmmo;
      this.currentAmmo = ammoKey;
      this.currentPrimaryAmmo = primaryAmmo;

      if (primaryAmmo < 0) {
        this.numberEl.textContent = "INF";
        this.reserveEl.textContent = "";
        this.reserveEl.style.display = "none";
        this.fillEl.style.width = "100%";
      } else {
        this.numberEl.textContent = String(primaryAmmo);
        if (reserveAmmo !== null) {
          this.reserveEl.textContent = `RES ${reserveAmmo}`;
          this.reserveEl.style.display = "";
        } else {
          this.reserveEl.textContent = "";
          this.reserveEl.style.display = "none";
        }

        const maxAmmo = def?.reloadModel === "clip" ? (def.clipSize ?? 1) : (def?.maxAmmo ?? 100);
        const percent = Math.max(0, Math.min(100, (primaryAmmo / maxAmmo) * 100));
        this.fillEl.style.width = `${percent}%`;
      }

      if (oldAmmo >= 0 && primaryAmmo < oldAmmo) {
        restartFlash(this.element, "fps-flash-loss", FLASH_CLASSES, FLASH_NAMES);
      }

      if (primaryAmmo >= 0 && primaryAmmo <= 5) {
        this.element.classList.add("fps-value-low");
      } else {
        this.element.classList.remove("fps-value-low");
      }
    }
  }

  public show(): void {
    this.element.style.display = "";
  }

  public hide(): void {
    this.element.style.display = "none";
  }

  public destroy(): void {
    this.element.remove();
  }
}
