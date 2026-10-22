import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { expect, it } from "vitest";
import { RemotePlayerRenderer } from "../RemotePlayerRenderer";

// Spectating asks for the rendered players every frame. The answer is reused
// rather than rebuilt, and must still be right after players die or leave.
it("reuses the rendered-player map while keeping it current", () => {
  const renderer = new RemotePlayerRenderer({} as never) as unknown as {
    hitboxes: Map<string, { smoothedPos: Vector3 }>;
    deadEntities: Map<string, number>;
    getRenderedPlayers: RemotePlayerRenderer["getRenderedPlayers"];
  };
  renderer.hitboxes.set("a", { smoothedPos: new Vector3(1, 2, 3) });
  renderer.hitboxes.set("b", { smoothedPos: new Vector3(4, 5, 6) });

  const first = renderer.getRenderedPlayers();
  const entryA = first.get("a");
  expect(entryA).toEqual({ position: new Vector3(1, 2, 3), dead: false });

  renderer.deadEntities.set("a", 0);
  renderer.hitboxes.delete("b");
  const second = renderer.getRenderedPlayers();
  expect(second).toBe(first);
  expect(second.get("a")).toBe(entryA);
  expect(second.get("a")?.dead).toBe(true);
  expect([...second.keys()]).toEqual(["a"]);
});

// The bomb asks for its carrier's spine every frame; the rig is searched once.
it("looks a bone up once per skeleton, under either Mixamo spelling", () => {
  const renderer = new RemotePlayerRenderer({} as never) as unknown as {
    hitboxes: Map<string, { model: unknown }>;
    getBoneTransform: RemotePlayerRenderer["getBoneTransform"];
  };
  const spine = { name: "mixamorig:Spine1", getTransformNode: () => "spine-node" };
  let reads = 0;
  const skeleton = {
    get bones() {
      reads++;
      return [{ name: "mixamorig:Hips", getTransformNode: () => "hips" }, spine];
    },
  };
  renderer.hitboxes.set("carrier", { model: { skeleton } });
  expect(renderer.getBoneTransform("carrier", "Spine1")).toBe("spine-node");
  expect(renderer.getBoneTransform("carrier", "Spine1")).toBe("spine-node");
  expect(renderer.getBoneTransform("carrier", "Tail")).toBeNull();
  expect(renderer.getBoneTransform("carrier", "Tail")).toBeNull();
  expect(reads).toBe(2);
});
