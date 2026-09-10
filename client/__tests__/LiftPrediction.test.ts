import { describe, expect, it } from "vitest";
import { liftBsp } from "../../../../engine/__tests__/fixtures/liftBsp";
import { SweepBackendAdapter } from "../../../../engine/physics/SweepBackendAdapter";
import { SweepCollisionBackend } from "../../../../engine/physics/SweepCollisionBackend";
import { Simulation } from "../../../../engine/server/core/Simulation";
import { createPlayerEntity } from "../../../../engine/server/ecs/Entity";
import { entityId, playerId } from "../../../../engine/server/ecs/types";
import { SharedCollisionWorld } from "../../../../shared/collision/SharedCollisionWorld";
import { FPSMovementSubsystem } from "../../server/systems/FPSMovementSubsystem";
import { type ServerSnapshot, V2NetworkClient } from "../V2NetworkClient";

async function world() {
  const backend = new SweepCollisionBackend();
  await backend.init(liftBsp());
  return new SharedCollisionWorld(new SweepBackendAdapter(backend));
}
describe("lift server/client prediction", () => {
  it("rewinds platform and rider together under delayed/lost snapshots, without advancing twice on replay", async () => {
    const serverWorld = await world();
    const clientWorld = await world();
    const physics = new FPSMovementSubsystem();
    physics.setCollisionWorld(serverWorld);
    const sim = new Simulation({ tickMs: 8 });
    sim.addSubsystem(physics);
    sim.initialize();
    const id = entityId(1);
    sim.getStateMut().addEntity(createPlayerEntity(id, playerId(1), { x: 0, y: 24.03125, z: 0 }));
    const client = new V2NetworkClient({ tickRate: 125 });
    client.setCollisionWorld(clientWorld);
    const snapshots: ServerSnapshot[] = [];
    const snapshot = (tick: number): ServerSnapshot => {
      const e = sim.getState().getEntity(id)!;
      return {
        tick,
        ackedInputSeq: tick,
        position: { ...e.transform!.position },
        velocity: { ...e.physics!.velocity },
        grounded: e.physics!.grounded,
        lifts: serverWorld.lifts!.snapshot(),
      };
    };
    client.bufferSnapshot(snapshot(0));
    client.processBufferedSnapshots();
    for (let tick = 1; tick <= 180; tick++) {
      sim
        .getStateMut()
        .getEntityMut(id)!
        .input!.inputQueue.push({ forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0, sequence: tick, weaponSlot: 0 });
      sim.tick();
      snapshots.push(snapshot(tick));
      client.processInput({ direction: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, buttons: 0, clientTick: tick });
      // About 64ms old, one snapshot in four delivered. Replay all unacked commands.
      if (tick > 8 && tick % 4 === 0) {
        client.bufferSnapshot(snapshots[tick - 9]);
        client.processBufferedSnapshots();
      }
      expect(client.getPosition().y).toBeCloseTo(sim.getState().getEntity(id)!.transform!.position.y, 4);
      expect(clientWorld.lifts!.snapshot()[0].offset).toBeCloseTo(serverWorld.lifts!.snapshot()[0].offset, 6);
    }
    expect(client.getPosition().y).toBeCloseTo(124.03125, 3);
  });
  it("advances once per server tick for multiple riders even without input packets", async () => {
    const collision = await world();
    const physics = new FPSMovementSubsystem();
    physics.setCollisionWorld(collision);
    const sim = new Simulation({ tickMs: 8 });
    sim.addSubsystem(physics);
    sim.initialize();
    for (const id of [1, 2])
      sim
        .getStateMut()
        .addEntity(createPlayerEntity(entityId(id), playerId(id), { x: id === 1 ? -20 : 20, y: 24.03125, z: 0 }));
    for (let i = 0; i < 10; i++) sim.tick();
    expect(collision.lifts!.snapshot()[0].offset).toBeCloseTo(-92);
    for (const id of [1, 2])
      expect(sim.getState().getEntity(entityId(id))!.transform!.position.y).toBeCloseTo(32.03125);
  });
  it("late join restores an already moving platform activated by another player", async () => {
    const collision = await world();
    const client = new V2NetworkClient({ tickRate: 125 });
    client.setCollisionWorld(collision);
    const lifts = collision.lifts!.snapshot();
    lifts[0].offset = -50;
    lifts[0].phase = "up";
    client.bufferSnapshot({
      tick: 100,
      ackedInputSeq: 0,
      position: { x: 500, y: 24, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: false,
      lifts,
    });
    client.processBufferedSnapshots();
    client.processInput({ direction: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, buttons: 0, clientTick: 101 });
    expect(collision.lifts!.snapshot()[0].offset).toBeCloseTo(-49.2);
  });
});
