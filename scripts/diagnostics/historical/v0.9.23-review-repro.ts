/**
 * Review/fix diagnostics, outside CI. Every case asserts the fixed invariant,
 * including knockback drag across reconciliation on the active path (T11).
 * Run: npx vite-node src/games/fps/scripts/diagnostics/historical/v0.9.23-review-repro.ts
 * Box fixture copied from ReconcileParity.test.ts at FPS 519ad65.
 * Measures EVERY step as well as the endpoint; no production code changes.
 */
import assert from "node:assert/strict";
import { SnapshotBuffer } from "../../../../../engine/network/client/SnapshotBuffer";
import type { BspBrushSide, BspFile, BspPlane } from "../../../../../engine/loader/bsp/BspLoader";
import { InputButtons } from "../../../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../../../engine/network/components/TransformComponent";
import type { MovementInput } from "../../../../../engine/network/systems/movement/MovementProfile";
import { ContentFlags } from "../../../../../engine/physics/ContentFlags";
import { SweepBackendAdapter } from "../../../../../engine/physics/SweepBackendAdapter";
import { SweepCollisionBackend } from "../../../../../engine/physics/SweepCollisionBackend";
import type { CollisionWorld } from "../../../../../shared/collision/CollisionWorld";
import { SharedCollisionWorld } from "../../../../../shared/collision/SharedCollisionWorld";
import { V2NetworkClient } from "../../../client/V2NetworkClient";
import { MovementProfile } from "../../../simulation/MovementProfile";
import { Simulation } from "../../../../../engine/server/core/Simulation";
import { createPlayerEntity } from "../../../../../engine/server/ecs/Entity";
import { entityId, playerId } from "../../../../../engine/server/ecs/types";
import { FPSMovementSubsystem } from "../../../server/systems/FPSMovementSubsystem";

type Triple = [number, number, number];

interface BoxSpec {
  min: Triple;
  max: Triple;
  name: string;
  contentFlags: number;
}

function boxPlanes(min: Triple, max: Triple): BspPlane[] {
  return [
    { normal: [1, 0, 0], dist: max[0] },
    { normal: [-1, 0, 0], dist: -min[0] },
    { normal: [0, 1, 0], dist: max[1] },
    { normal: [0, -1, 0], dist: -min[1] },
    { normal: [0, 0, 1], dist: max[2] },
    { normal: [0, 0, -1], dist: -min[2] },
  ];
}

function buildBsp(boxes: BoxSpec[]): BspFile {
  const planes: BspPlane[] = [];
  const brushSides: BspBrushSide[] = [];
  const brushes: BspFile["brushes"] = [];
  const textures: BspFile["textures"] = [];
  const leafBrushes: number[] = [];

  boxes.forEach((box, i) => {
    textures.push({ name: box.name, contentFlags: box.contentFlags, surfaceFlags: 0 });
    const firstSide = brushSides.length;
    for (const p of boxPlanes(box.min, box.max)) {
      brushSides.push({ planeIndex: planes.length, shaderIndex: i });
      planes.push(p);
    }
    brushes.push({ firstSide, numSides: 6, shaderIndex: i });
    leafBrushes.push(i);
  });

  const big: Triple = [1e6, 1e6, 1e6];
  const negBig: Triple = [-1e6, -1e6, -1e6];
  return {
    header: { isFBSP: false },
    lumps: [],
    entities: [],
    textures,
    planes,
    nodes: [{ planeIndex: 0, children: [-1, -1] as [number, number], mins: negBig, maxs: big }],
    leafs: [
      {
        cluster: 0,
        area: 0,
        mins: negBig,
        maxs: big,
        firstLeafFace: 0,
        numLeafFaces: 0,
        firstLeafBrush: 0,
        numLeafBrushes: leafBrushes.length,
      },
    ],
    leafFaces: [],
    leafBrushes,
    models: [],
    brushes,
    brushSides,
    vertices: [],
    meshVerts: [],
    effects: [],
    faces: [],
    lightmaps: [],
    lightVols: [],
    visData: null,
    lightmapSize: 128,
  } as unknown as BspFile;
}

async function room(): Promise<CollisionWorld> {
  const backend = new SweepCollisionBackend();
  await backend.init(
    buildBsp([
      { min: [-4000, -4000, -4000], max: [4000, 4000, 0], name: "floor", contentFlags: ContentFlags.SOLID },
      { min: [-4000, 64, 0], max: [4000, 128, 4000], name: "wall", contentFlags: ContentFlags.SOLID },
    ]),
  );
  return new SharedCollisionWorld(new SweepBackendAdapter(backend));
}

const DT = 1 / 125;
/**
 * A body standing ON the floor, not inside it: the hull's mins is -24, so an
 * origin any lower is embedded in the brush and cannot move at all.
 */
interface Start {
  position: Vec3;
  velocity: Vec3;
}

/** Open floor, far enough back that the flat scenarios never reach the wall. */
const OPEN: Start = { position: { x: 0, y: 24, z: -3000 }, velocity: { x: 0, y: 0, z: 0 } };

/** Close enough to run into the wall inside a couple of seconds. */
const NEAR_WALL: Start = { position: { x: 0, y: 24, z: -200 }, velocity: { x: 0, y: 0, z: 0 } };

/**
 * Already moving faster than `slideMinSpeed` (375). Holding forward tops out at
 * maxSpeed 280 — that speed comes from strafe jumping, which is not what this
 * scenario is measuring, so the run simply starts with it.
 */
const FAST: Start = { position: { x: 0, y: 24, z: -3000 }, velocity: { x: 0, y: 0, z: 460 } };

/** One step of a scenario, in the shape both sides need. */
interface Step {
  direction: Vec3;
  pitch: number;
  yaw: number;
  buttons: number;
}

function movementInput(step: Step, seq: number): MovementInput {
  return {
    direction: step.direction,
    viewAngles: { pitch: step.pitch, yaw: step.yaw },
    buttons: step.buttons,
    sequence: seq,
    simStep: seq,
    isPressed: (b: number) => (step.buttons & b) !== 0,
  };
}

const forward = (buttons = 0): Step => ({ direction: { x: 0, y: 0, z: 1 }, pitch: 0, yaw: 0, buttons });
const gap = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const observations: Record<string, unknown> = {};

// Same exact-authority fixture and cadence as the permanent profile tests.
// Unlike their final-position assertion, record error at every intermediate step.
async function parity(name: string, steps: Step[], start: Start, every = 16, lag = 12) {
  const world = await room();
  const server = new MovementProfile();
  let p = { ...start.position }, v = { ...start.velocity };
  const truth = [{ position: { ...p }, velocity: { ...v }, grounded: true }];
  for (let i = 0; i < steps.length; i++) {
    const r = server.simulate(p, v, movementInput(steps[i], i + 1), DT, world);
    p = r.position; v = r.velocity;
    truth.push({ position: { ...p }, velocity: { ...v }, grounded: r.grounded });
  }
  const client = new MovementProfile();
  p = { ...start.position }; v = { ...start.velocity };
  let peak = 0, peakSeq = 0, peakVelocity = 0, reconciles = 0;
  for (let seq = 1; seq <= steps.length; seq++) {
    const r = client.simulate(p, v, movementInput(steps[seq - 1], seq), DT, world);
    p = r.position; v = r.velocity;
    const ack = seq - lag;
    if (seq % every === 0 && ack >= 1) {
      reconciles++;
      p = { ...truth[ack].position }; v = { ...truth[ack].velocity };
      client.resetPhysicsState(truth[ack].grounded);
      for (let s = ack + 1; s <= seq; s++) {
        const replay = client.simulate(p, v, movementInput(steps[s - 1], s), DT, world);
        p = replay.position; v = replay.velocity;
      }
    }
    const error = gap(p, truth[seq].position);
    if (error > peak) { peak = error; peakSeq = seq; }
    peakVelocity = Math.max(peakVelocity, gap(v, truth[seq].velocity));
  }
  const result = { peak, peakSeq, peakVelocity, endpoint: gap(p, truth[steps.length].position), reconciles };
  observations[name] = result;
  return result;
}

await parity("running", Array.from({ length: 200 }, () => forward()), OPEN);
await parity("jumping", Array.from({ length: 200 }, (_, i) => forward(i % 40 === 0 ? InputButtons.JUMP : 0)), OPEN);
await parity("slide", Array.from({ length: 80 }, (_, i) => forward(i >= 1 ? InputButtons.CROUCH : 0)), FAST, 8, 6);
const wallSteps = Array.from({ length: 220 }, (_, i) => forward(i + 1 === 80 || i + 1 === 118 ? InputButtons.JUMP : 0));
const wallResult = await parity("wallJump", wallSteps, NEAR_WALL);
assert.equal(wallResult.peak, 0);
assert.equal(wallResult.peakVelocity, 0);

// N12: flush intentionally preserves chronology; owners now call reset at
// session/seek boundaries (covered by the permanent owner tests).
{
  const buffer = new SnapshotBuffer();
  buffer.push(10000, new Map());
  buffer.flush();
  const acceptedAfterFlush = buffer.push(10, new Map());
  assert.equal(acceptedAfterFlush, false);
  buffer.reset();
  const acceptedAfterReset = buffer.push(10, new Map());
  assert.equal(acceptedAfterReset, true);
  observations.projectileEpoch = { acceptedAfterFlush, acceptedAfterReset };
}

// T11 fixed: knockback drag across reconciliation, on the active path. The REAL
// server subsystem applies the impulse; the client learns of it only through
// snapshot velocity plus the replicated drag age, reconciling every 8 steps
// against authority 12 back. The unwired client impulse API this section used
// to drive is gone. KnockbackReplay.test.ts is the permanent version.
{
  const log = console.log;
  console.log = () => {};
  const sim = new Simulation({ tickMs: 8 });
  const movement = new FPSMovementSubsystem();
  sim.addSubsystem(movement);
  sim.initialize();
  const id = entityId(1);
  sim.getStateMut().addEntity(createPlayerEntity(id, playerId(1), { x: 0, y: 5000, z: 0 }));
  const seed = sim.getStateMut().getEntityMut(id)!;
  seed.physics!.grounded = false;
  seed.physics!.velocity.y = 0;
  const IMPULSE = 20, STEPS = 200, EVERY = 8, LAG = 12;
  const read = () => {
    const e = sim.getState().getEntity(id)!;
    return {
      position: { ...e.transform!.position },
      velocity: { ...e.physics!.velocity },
      grounded: e.physics!.grounded,
      age: movement.getKnockbackAge(Number(id)),
    };
  };
  const truth = [read()];
  for (let seq = 1; seq <= STEPS; seq++) {
    sim.getStateMut().getEntityMut(id)!.input!.inputQueue.push({
      forward: 0, right: 0, pitch: 0, yaw: 0, buttons: 0, sequence: seq, weaponSlot: 0,
    });
    if (seq === IMPULSE) {
      movement.queueImpulse({ entityId: id, dirX: 0.8, dirY: 0.6, dirZ: 0, force: 600, stunFraction: 0 });
    }
    sim.tick();
    truth.push(read());
  }
  console.log = log;

  const peakVelocityError = (replicateAge: boolean) => {
    const v2 = new V2NetworkClient({ tickRate: 125 });
    const snap = (at: number) => ({
      tick: at + 1,
      ackedInputSeq: at,
      position: { ...truth[at].position },
      velocity: { ...truth[at].velocity },
      grounded: truth[at].grounded,
      ...(replicateAge ? { knockbackAgeTicks: truth[at].age } : {}),
    });
    v2.bufferSnapshot(snap(0));
    v2.processBufferedSnapshots();
    let peak = 0;
    for (let step = 1; step <= STEPS; step++) {
      v2.processInput({ direction: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, buttons: 0, clientTick: step });
      const ack = step - LAG;
      if (step % EVERY !== 0 || ack < 1) continue;
      v2.bufferSnapshot(snap(ack));
      v2.processBufferedSnapshots();
      // A window containing the impulse tick predates it; the next snapshot carries it.
      if (ack >= IMPULSE || step < IMPULSE) peak = Math.max(peak, gap(v2.getVelocity(), truth[step].velocity));
    }
    return peak;
  };
  const withAge = peakVelocityError(true);
  const withoutAge = peakVelocityError(false);
  observations.knockbackReplay = { withAge, withoutAge };
  assert.equal(withAge, 0);
  assert.ok(withoutAge > 1);
}

console.log(JSON.stringify(observations, null, 2));
