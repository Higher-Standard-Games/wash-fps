import { GamePanel } from "../../../../../engine/ui/panels/GamePanel";
import { FPSSettingsView } from "../../settings/FPSSettingsView";

export class FPSSettingsOverlay extends GamePanel {
  private readonly settingsView: FPSSettingsView;

  constructor() {
    super("SETTINGS");
    this.settingsView = new FPSSettingsView();
    this.setContent(this.settingsView.getElement());

    const closeBtn = this.createButton("Close", "", () => {
      this.close();
    });
    this.footerArea.appendChild(closeBtn);
  }

  public override open(): void {
    void this.settingsView.refresh();
    super.open();
  }

  public override destroy(): void {
    this.settingsView.destroy();
    super.destroy();
  }
}
