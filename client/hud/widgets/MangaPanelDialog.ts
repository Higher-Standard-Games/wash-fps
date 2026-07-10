import { GameDialogPanel } from "../../../../../engine/ui/panels/GameDialogPanel";

/**
 * Legacy FPS-local name for the engine compact dialog panel.
 */
export class MangaPanelDialog extends GameDialogPanel {
  constructor(title: string, extraClass: string = "") {
    super({ title, extraClass });
  }
}
