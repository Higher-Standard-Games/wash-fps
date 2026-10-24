import { PackageStore } from "../../../engine/loader/pk3/PackageStore";
import { UIStyles } from "../../../engine/ui/UIStyles";
import { LobbyAssetPreparation } from "./LobbyAssetPreparation";
import settingsCSS from "./settings/FPSSettingsView.css?raw";

/** A view of application-owned work; destroying it never cancels downloads. */
export class LobbyDownloadIndicator {
  readonly root = document.createElement("details");
  private summary = document.createElement("summary");
  private text = document.createElement("pre");
  private packages = document.createElement("ul");
  private pause = document.createElement("input");
  private timer: ReturnType<typeof setInterval>;
  private readonly outside = (event: PointerEvent): void => {
    if (this.root.open && event.target instanceof Node && !this.root.contains(event.target)) {
      this.root.open = false;
    }
  };

  constructor() {
    UIStyles.injectCSS("fps-settings-view", settingsCSS);
    this.root.className = "lobby-downloads";
    this.summary.className = "lobby-credits-key";
    this.summary.setAttribute("aria-label", "Asset download status and controls");
    const body = document.createElement("div");
    body.className = "fps-set-pop__card lobby-downloads__details";
    const header = document.createElement("div");
    header.className = "fps-set-pop__head";
    const heading = document.createElement("strong");
    heading.className = "fps-set-pop__q lobby-downloads__heading";
    heading.textContent = "Downloads";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "fps-set-pop__close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close downloads");
    close.addEventListener("click", () => {
      this.root.open = false;
    });
    header.append(heading, close);
    this.packages.className = "lobby-downloads__packages";
    const controls = document.createElement("div");
    controls.className = "fps-set-pop__foot lobby-downloads__controls";
    const pauseLabel = document.createElement("label");
    pauseLabel.className = "lobby-downloads__pause";
    this.pause.type = "checkbox";
    pauseLabel.append(this.pause, "Pause background downloads");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "fps-set-opt lobby-downloads__retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => LobbyAssetPreparation.shared.retry());
    this.pause.addEventListener("change", () => {
      PackageStore.shared.setPaused(this.pause.checked);
      this.render();
    });
    controls.append(pauseLabel, retry);
    body.append(header, this.text, this.packages, controls);
    this.root.append(this.summary, body);
    LobbyAssetPreparation.shared.selectMap(null);
    this.render();
    this.timer = setInterval(() => this.render(), 250);
    document.addEventListener("pointerdown", this.outside, true);
  }

  private render(): void {
    const status = LobbyAssetPreparation.shared.status();
    this.summary.textContent = status.label;
    this.text.textContent = status.detail;
    this.packages.replaceChildren(
      ...status.packages.map(({ filename, state }) => {
        const row = document.createElement("li");
        const name = document.createElement("span");
        const value = document.createElement("strong");
        name.textContent = filename;
        value.textContent = state;
        row.append(name, value);
        return row;
      }),
    );
    this.pause.checked = PackageStore.shared.paused;
  }

  destroy(): void {
    clearInterval(this.timer);
    document.removeEventListener("pointerdown", this.outside, true);
    this.root.remove();
  }
}
