import entityDefs from "../../../../editor/gamepacks/washoi.game/basewashoi/entities.def?raw";
import { parseBrushEntityDefs, parseEntityDefs, registerGameEntityCatalog } from "../../../engine/editor/EntityCatalog";

/** Install Washoi's authoring definitions before opening SHAGGED or inspecting maps. */
export function registerFpsEditorCatalog(): void {
  registerGameEntityCatalog({
    pointClasses: parseEntityDefs(entityDefs),
    brushClasses: parseBrushEntityDefs(entityDefs),
  });
}
