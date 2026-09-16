/**
 * Differential client/server replay over real geometry (T01).
 *
 * The ledger's open theory is that reconciliation restores position, velocity
 * and grounded, but nothing else: slide, wall-jump, ledge and ladder state all
 * live in the movement profile and survive the reset untouched or half-reset.
 *
 * The experiment is a parity one, and it needs no packet loss to be meaningful:
 * give the client a snapshot that is EXACTLY what the server computed, and
 * replay the inputs the server has not acked yet. Prediction was already right,
 * so reconciling has nothing to correct — it must be a no-op. Whatever drift
 * shows up is the hidden state the reset did not restore, measured rather than
 * argued.
 *
 * Both sides run the real `MovementProfile` against the real collision stack,
 * and the client side is the real `V2NetworkClient`, so the reconcile path
 * under test is the shipped one.
 *
 * WORLD (Q3 coords, z up; the profile's API is Babylon, y up):
 *   floor  z <= 0
 *   wall   y in [64, 128]        — something to wall jump off
 */

import { describe, expect, it } from "vitest";
import type { BspBrushSide, BspFile, BspPlane } from "../../../../engine/loader/bsp/BspLoader";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../../engine/network/components/TransformComponent";
import type { MovementInput } from "../../../../engine/network/systems/movement/MovementProfile";
import { ContentFlags } from "../../../../engine/physics/ContentFlags";
import { SweepBackendAdapter } from "../../../../engine/physics/SweepBackendAdapter";
import { SweepCollisionBackend } from "../../../../engine/physics/SweepCollisionBackend";
import type { CollisionWorld } from "../../../../shared/collision/CollisionWorld";
import { SharedCollisionWorld } from "../../../../shared/collision/SharedCollisionWorld";
import { V2NetworkClient } from "../../client/V2NetworkClient";
import { MovementProfile } from "../../simulation/MovementProfile";

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

interface Sample {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
}

/**
 * Uninterrupted simulation — the authority every comparison is made against.
 * One profile, one step per command, never reset. This is what the server does
 * to its own per-entity profile.
 */
function authority(world: CollisionWorld, steps: Step[], start: Start): Sample[] {
  const profile = new MovementProfile();
  profile.resetPhysicsState(true); // Match the grounded initial snapshot given to V2.
  let position = { ...start.position };
  let velocity: Vec3 = { ...start.velocity };
  const history: Sample[] = [{ position: { ...position }, velocity: { ...velocity }, grounded: true }];

  steps.forEach((step, i) => {
    const result = profile.simulate(position, velocity, movementInput(step, i + 1), DT, world);
    position = result.position;
    velocity = result.velocity;
    history.push({ position: { ...position }, velocity: { ...velocity }, grounded: result.grounded });
  });
  return history;
}

/**
 * The same commands through the real client, reconciling every `every` steps
 * against the authority's state `lag` steps back — the exact state, so a
 * correct reconcile changes nothing.
 */
function predicted(
  world: CollisionWorld,
  steps: Step[],
  truth: Sample[],
  start: Start,
  opts: { every: number; lag: number; jitter?: number },
): { position: Vec3; reconciles: number; peakPosition: number; peakVelocity: number } {
  let peakPosition = 0,
    peakVelocity = 0;
  const client = new V2NetworkClient({ tickRate: 125 });
  client.setCollisionWorld(world);
  client.bufferSnapshot({
    tick: 0,
    ackedInputSeq: 0,
    position: { ...start.position },
    velocity: { ...start.velocity },
    grounded: true,
  });
  client.processBufferedSnapshots();

  steps.forEach((step, i) => {
    const seq = i + 1;
    client.processInput({ ...step, clientTick: seq });
    const acked = seq - opts.lag;
    if (seq % opts.every === 0 && acked >= 1) {
      // `jitter` stands in for the float32/float64 gap between a server
      // position and the one the client would have computed: never zero in a
      // real session, far too small to see, and applied every single snapshot.
      const nudge = opts.jitter ?? 0;
      client.bufferSnapshot({
        tick: seq,
        ackedInputSeq: acked,
        position: {
          x: truth[acked].position.x + nudge,
          y: truth[acked].position.y,
          z: truth[acked].position.z + nudge,
        },
        velocity: { ...truth[acked].velocity },
        grounded: truth[acked].grounded,
      });
      client.processBufferedSnapshots();
    }
    peakPosition = Math.max(peakPosition, gap(client.getPosition(), truth[seq].position));
    peakVelocity = Math.max(peakVelocity, gap(client.getState().velocity, truth[seq].velocity));
  });
  return {
    position: client.getPosition(),
    reconciles: client.getDebugInfo().reconcileCount,
    peakPosition,
    peakVelocity,
  };
}

const gap = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The slide run is short, so it reconciles more often to still exercise the path. */
const SLIDE_CADENCE = { every: 8, lag: 6 };

/**
 * Run at the wall, jump to get airborne, then jump again alongside it. Two
 * discrete presses: the wall jump needs a fresh jump EDGE, so holding the
 * button never produces one — which is how a scenario ends up merely
 * "available" next to a wall without ever leaving the ground.
 */
const wallJumpRun = (): Step[] =>
  Array.from({ length: 220 }, (_, i) => forward(i + 1 === 80 || i + 1 === 118 ? InputButtons.JUMP : 0));

/** Walk toward the wall (Babylon +z). */
const forward = (buttons = 0): Step => ({ direction: { x: 0, y: 0, z: 1 }, pitch: 0, yaw: 0, buttons });

/** How far reconciliation moved the client away from an authority it matched. */
async function drift(
  steps: Step[],
  start: Start,
  opts: { every: number; lag: number; jitter?: number } = { every: 16, lag: 12 },
): Promise<number> {
  const world = await room();
  const truth = authority(world, steps, start);
  const run = predicted(world, steps, truth, start, opts);
  // A harness that silently stopped reconciling would report perfect parity
  // forever. Every scenario must actually exercise the path under test.
  expect(run.reconciles).toBeGreaterThan(5);
  expect(run.peakVelocity).toBeLessThan(0.05);
  return run.peakPosition;
}

/** Whether a scenario actually entered the state it claims to exercise. */
function observed(world: CollisionWorld, steps: Step[], start: Start) {
  const profile = new MovementProfile();
  profile.resetPhysicsState(true); // Match the grounded initial snapshot given to V2.
  let position = { ...start.position };
  let velocity: Vec3 = { ...start.velocity };
  let slid = false;
  let charging = 0;
  let airborne = 0;
  let topSpeed = 0;
  let peakY = start.position.y;
  steps.forEach((step, i) => {
    const r = profile.simulate(position, velocity, movementInput(step, i + 1), DT, world);
    position = r.position;
    velocity = r.velocity;
    if (r.isSliding) slid = true;
    // Only "charging" is an actual wall jump. "available" merely means a wall
    // is in reach, which a scenario can hit without ever leaving the ground.
    if (r.wallJumpState === "charging") charging++;
    if (!r.grounded) airborne++;
    peakY = Math.max(peakY, position.y);
    topSpeed = Math.max(topSpeed, Math.hypot(velocity.x, velocity.z));
  });
  return { slid, charging, airborne, topSpeed, peakY, travelled: gap(start.position, position) };
}

/**
 * The same reconcile the client performs — restore authority, `resetPhysicsState`,
 * replay the unacked inputs — but WITHOUT the suppression gate that skips it
 * during a wall jump or ledge grab. That gate is exactly what makes the client
 * path unable to measure wall-jump parity: it declines to reconcile there, so a
 * clean result through `V2NetworkClient` says nothing about the hidden state.
 *
 * This is the T01 question stated directly: does resetting and replaying
 * reproduce an uninterrupted simulation?
 */
function profileReplay(
  world: CollisionWorld,
  steps: Step[],
  truth: Sample[],
  start: Start,
  opts: { every: number; lag: number },
): { position: Vec3; reconciles: number; peakPosition: number; peakVelocity: number } {
  const profile = new MovementProfile();
  profile.resetPhysicsState(true); // Match the grounded initial snapshot given to V2.
  let position = { ...start.position };
  let velocity: Vec3 = { ...start.velocity };
  let reconciles = 0,
    peakPosition = 0,
    peakVelocity = 0;

  steps.forEach((step, i) => {
    const seq = i + 1;
    const result = profile.simulate(position, velocity, movementInput(step, seq), DT, world);
    position = result.position;
    velocity = result.velocity;

    const acked = seq - opts.lag;
    if (seq % opts.every === 0 && acked >= 1) {
      reconciles++;
      position = { ...truth[acked].position };
      velocity = { ...truth[acked].velocity };
      profile.resetPhysicsState(truth[acked].grounded);
      for (let s = acked + 1; s <= seq; s++) {
        const replayed = profile.simulate(position, velocity, movementInput(steps[s - 1], s), DT, world);
        position = replayed.position;
        velocity = replayed.velocity;
      }
    }
    peakPosition = Math.max(peakPosition, gap(position, truth[seq].position));
    peakVelocity = Math.max(peakVelocity, gap(velocity, truth[seq].velocity));
  });
  return { position, reconciles, peakPosition, peakVelocity };
}

async function profileDrift(steps: Step[], start: Start, opts = { every: 16, lag: 12 }): Promise<number> {
  const world = await room();
  const truth = authority(world, steps, start);
  const run = profileReplay(world, steps, truth, start, opts);
  expect(run.reconciles).toBeGreaterThan(5);
  expect(run.peakVelocity).toBeLessThan(0.05);
  return run.peakPosition;
}

describe("Reconciling an exact snapshot is a no-op", () => {
  it("running flat", async () => {
    const world = await room();
    const steps = Array.from({ length: 200 }, () => forward());
    expect(observed(world, steps, OPEN).travelled).toBeGreaterThan(100);
    expect(await drift(steps, OPEN)).toBeLessThan(0.05);
  });

  it("jumping — grounded flips, so the reset has a transition to land on", async () => {
    const world = await room();
    const steps = Array.from({ length: 200 }, (_, i) => forward(i % 40 === 0 ? InputButtons.JUMP : 0));
    expect(observed(world, steps, OPEN).airborne).toBeGreaterThan(50);
    expect(await drift(steps, OPEN)).toBeLessThan(0.05);
  });

  it("crouch slide — the state the reset deliberately preserves", async () => {
    const world = await room();
    // Crouch at once: ground friction drops the run below slideMinSpeed within
    // a handful of steps, and a slide that never starts measures nothing.
    // The run also STOPS while still sliding — carried past the slide the body
    // comes to rest, and a resting body absorbs any error rather than showing
    // it, which would leave the scenario unable to fail.
    const steps = Array.from({ length: 80 }, (_, i) => forward(i >= 1 ? InputButtons.CROUCH : 0));
    expect(observed(world, steps, FAST).slid).toBe(true);
    expect(await drift(steps, FAST, SLIDE_CADENCE)).toBeLessThan(0.05);
  });
});

/**
 * An exact snapshot is the clean case. A real snapshot is never exact: the
 * server holds float64 and the client rebuilds from a float32 wire position, so
 * every reconcile lands the player a hair off where prediction had them.
 *
 * What matters is whether that hair COMPOUNDS. Hidden state is the plausible
 * amplifier — a trace landing a fraction of a unit further from a wall can flip
 * a wall-jump detection, and a flipped detection is worth hundreds of units.
 */
describe("A sub-unit snapshot nudge stays sub-unit", () => {
  const JITTER = 0.01;

  it("running flat", async () => {
    const steps = Array.from({ length: 200 }, () => forward());
    expect(await drift(steps, OPEN, { every: 16, lag: 12, jitter: JITTER })).toBeLessThan(1);
  });

  it("crouch slide", async () => {
    const steps = Array.from({ length: 80 }, (_, i) => forward(i >= 1 ? InputButtons.CROUCH : 0));
    expect(await drift(steps, FAST, { ...SLIDE_CADENCE, jitter: JITTER })).toBeLessThan(1);
  });
});

/**
 * Wall jump has to be measured below the client: `V2NetworkClient` suppresses
 * reconciliation for the whole wall-jump window (N05), so a clean run through it
 * proves only that the skip fired.
 */
describe("Reset-and-replay reproduces an uninterrupted simulation", () => {
  it("running flat", async () => {
    const steps = Array.from({ length: 200 }, () => forward());
    expect(await profileDrift(steps, OPEN)).toBeLessThan(0.05);
  });

  it("wall jump — the window the client declines to reconcile in", async () => {
    const world = await room();
    const steps = wallJumpRun();
    const seen = observed(world, steps, NEAR_WALL);
    // A real wall jump, not just a wall within reach: the boost carries the
    // body far above the ~100 a plain jump from this floor reaches.
    expect(seen.charging).toBeGreaterThan(0);
    expect(seen.peakY).toBeGreaterThan(140);
    expect(await profileDrift(steps, NEAR_WALL)).toBeLessThan(0.05);
  });
});
