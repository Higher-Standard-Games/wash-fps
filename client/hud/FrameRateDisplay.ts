import { Cvar } from "../../../../engine/core/Cvar";
import { registerFpsDisplayCvar } from "../../../../engine/core/FpsDisplaySettings";
import { UIStyles } from "../../../../engine/ui/UIStyles";
import styles from "./styles/FrameRateDisplay.css?raw";

/** App-wide readout, also available in the lobby and during demo playback. */
export class FrameRateDisplay {
  private readonly element = document.createElement("div");
  private readonly value = document.createElement("span");
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly getFps: () => number) {
    registerFpsDisplayCvar();
    UIStyles.injectCSS("fps-frame-rate", styles);
    this.element.id = "fps-display";
    this.element.className = "fps-frame-rate";
    this.element.title = "Frames per second";
    this.value.className = "fps-frame-rate__value";
    const label = document.createElement("span");
    label.className = "fps-frame-rate__label";
    label.textContent = "FPS";
    this.element.append(this.value, label);
    document.body.append(this.element);
    this.update();
    // Readable updates without a second animation loop or per-frame DOM writes.
    this.timer = setInterval(() => this.update(), 250);
  }

  private update(): void {
    const hidden = !Cvar.getBool("show_fps");
    if (this.element.hidden !== hidden) this.element.hidden = hidden;
    if (hidden) return;
    const fps = this.getFps();
    const text = Number.isFinite(fps) && fps > 0 ? fps.toFixed(0) : "—";
    if (this.value.textContent !== text) this.value.textContent = text;
  }

  destroy(): void {
    clearInterval(this.timer);
    this.element.remove();
    UIStyles.removeCSS("fps-frame-rate");
  }
}
