import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOperations, emptyDocument } from "../../../../../engine/editor/api/Operations";
import { clearGameEntityCatalog } from "../../../../../engine/editor/EntityCatalog";
import { registerFpsEditorCatalog } from "../../FpsEditorCatalog";

beforeEach(registerFpsEditorCatalog);
afterEach(clearGameEntityCatalog);

describe("gen.teleporter and gen.jumppad", () => {
  const fixture = () =>
    applyOperations(emptyDocument(), [
      { op: "entity.place", id: "spawn", classname: "info_player_deathmatch", origin: { x: 0, y: 0, z: 24 } },
      { op: "gen.teleporter", id: "tele", at: { x: 128, y: 0, z: 0 }, to: { x: 1024, y: 0, z: 0 }, angle: 90 },
      { op: "gen.jumppad", id: "pad", at: { x: -128, y: 0, z: 0 }, to: { x: -128, y: 512, z: 192 } },
    ]);

  it("links each trigger to its destination, so Map Health finds no broken links", () => {
    const { doc, issues } = fixture();
    expect(issues).toEqual([]);
    const tele = doc.brushEntities?.find((e) => e.id === "tele");
    const dest = doc.entities.find((e) => e.id === "tele-dest");
    expect(tele?.classname).toBe("trigger_teleport");
    expect(dest?.classname).toBe("misc_teleporter_dest");
    expect(tele?.keys.target).toBe(dest?.keys.targetname);
    expect(dest?.keys.angle).toBe("90");
    const pad = doc.brushEntities?.find((e) => e.id === "pad");
    const target = doc.entities.find((e) => e.id === "pad-target");
    expect(pad?.classname).toBe("trigger_push");
    expect(target?.classname).toBe("target_position");
    expect(pad?.keys.target).toBe(target?.keys.targetname);
  });

  it("puts trigger brushes on the floor with the trigger texture, and destinations at standing height", () => {
    const { doc } = fixture();
    const trigger = doc.brushes.find((b) => b.id === "tele-trigger")!;
    expect(trigger.shader).toBe("common/trigger");
    expect(trigger.min).toEqual({ x: 96, y: -32, z: 0 });
    expect(trigger.max.z).toBe(64);
    expect(doc.entities.find((e) => e.id === "tele-dest")?.origin.z).toBe(24);
    expect(doc.entities.find((e) => e.id === "pad-target")?.origin.z).toBe(216);
  });
});
