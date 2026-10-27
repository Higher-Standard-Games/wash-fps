// Washoi manga-style combined health + armor readout.

import type { FPSHudWidget, HUDState } from "../HudWidget";
import { restartFlash } from "../restartFlash";

const FLASH_CLASSES = [
  "fps-vitals--loss",
  "fps-vitals--gain",
  "fps-vitals--armor-gain",
  "fps-vitals--armor-loss",
] as const;
const FLASH_NAMES = ["fps-vitals-ink-hit", "fps-vitals-plate-chip"] as const;

const ARMOR_PLATE_VALUE = 25;
const ARMOR_PLATES = 4;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export class FPSVitalsBlock implements FPSHudWidget {
  private element: HTMLElement;
  private hpNumberEl!: HTMLElement;
  private armorNumberEl!: HTMLElement;
  private plateFillEls: HTMLElement[] = [];
  private currentHealth: number = -1;
  private currentArmor: number = -1;

  constructor() {
    this.element = this.createElement();
  }

  private createElement(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "fps-vitals-block";

    const depth = document.createElement("div");
    depth.className = "fps-vitals-depth";
    wrapper.appendChild(depth);

    const hpSlab = document.createElement("div");
    hpSlab.className = "fps-vitals-hp-slab";
    wrapper.appendChild(hpSlab);

    const hpMark = document.createElement("div");
    hpMark.className = "fps-vitals-mark";
    hpMark.textContent = "HP";
    hpSlab.appendChild(hpMark);

    this.hpNumberEl = document.createElement("div");
    this.hpNumberEl.className = "fps-vitals-number";
    this.hpNumberEl.textContent = "100";
    hpSlab.appendChild(this.hpNumberEl);

    const hpCaption = document.createElement("div");
    hpCaption.className = "fps-vitals-caption";
    hpCaption.textContent = "VITAL";
    hpSlab.appendChild(hpCaption);

    const armorStack = document.createElement("div");
    armorStack.className = "fps-vitals-armor-stack";
    wrapper.appendChild(armorStack);

    const armorLabel = document.createElement("div");
    armorLabel.className = "fps-vitals-armor-label";
    armorLabel.textContent = "PLATES";
    armorStack.appendChild(armorLabel);

    const plates = document.createElement("div");
    plates.className = "fps-vitals-armor-plates";
    armorStack.appendChild(plates);

    for (let i = 0; i < ARMOR_PLATES; i++) {
      const plate = document.createElement("div");
      plate.className = "fps-vitals-armor-plate";

      const fill = document.createElement("div");
      fill.className = "fps-vitals-armor-fill";
      fill.style.transform = "scaleX(0)";
      plate.appendChild(fill);

      plates.appendChild(plate);
      this.plateFillEls.push(fill);
    }

    this.armorNumberEl = document.createElement("div");
    this.armorNumberEl.className = "fps-vitals-armor-number";
    this.armorNumberEl.textContent = "0";
    armorStack.appendChild(this.armorNumberEl);

    const ink = document.createElement("div");
    ink.className = "fps-vitals-ink";
    wrapper.appendChild(ink);

    return wrapper;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(state: HUDState): void {
    const health = Math.max(0, Math.round(state.health));
    const armor = Math.max(0, Math.round(state.armor));

    if (health !== this.currentHealth) {
      const previous = this.currentHealth;
      this.currentHealth = health;
      this.hpNumberEl.textContent = String(health);
      this.element.style.setProperty("--hp-fill", `${clamp01(health / 100) * 100}%`);
      if (previous >= 0) this.flash(health < previous ? "fps-vitals--loss" : "fps-vitals--gain");
    }

    if (armor !== this.currentArmor) {
      const previous = this.currentArmor;
      this.currentArmor = armor;
      this.armorNumberEl.textContent = String(armor);
      this.updateArmorPlates(armor);
      if (previous >= 0) this.flash(armor > previous ? "fps-vitals--armor-gain" : "fps-vitals--armor-loss");
    }

    this.element.classList.toggle("fps-vitals--critical", health <= 25);
    this.element.classList.toggle("fps-vitals--no-armor", armor <= 0);
  }

  private updateArmorPlates(armor: number): void {
    for (let i = 0; i < this.plateFillEls.length; i++) {
      const start = i * ARMOR_PLATE_VALUE;
      const fill = clamp01((armor - start) / ARMOR_PLATE_VALUE);
      this.plateFillEls[i].style.transform = `scaleX(${fill})`;
    }
  }

  private flash(className: string): void {
    restartFlash(this.element, className, FLASH_CLASSES, FLASH_NAMES);
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
