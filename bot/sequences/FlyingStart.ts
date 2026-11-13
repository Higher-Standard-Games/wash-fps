/**
 * FlyingStart — joining a learned route's script on the run, without stopping.
 *
 * A learned route's script starts from a standstill on its mark: a sprint
 * run-up along the route's heading, then the recorded trick (RouteLearner).
 * A player does not stop on a mark before a trickjump. So the run-up is
 * replayed once from the mark, keeping the position and velocity after each of
 * its commands, and a bot running in along the line that matches one of those
 * states (place, speed and direction) can take over the script from there.
 *
 * Nothing is trusted to the match alone: before joining, the rest of the script
 * is simulated from the bot's exact position and velocity with the game's own
 * movement, and the bot joins only if that lands where the route lands. The
 * simulation is the same one the server runs, so a join that lands in the
 * check lands in the game.
 */

import type { TriggerVolume } from "../../../../shared/bsp/TriggerTable";
import type { CollisionWorld } from "../../../../shared/collision/CollisionWorld";
import { MovementProfile } from "../../simulation/MovementProfile";
import { InputButtons } from "../BotConfig";
import type { Vec3 } from "../BotGameState";
import { type LearnedRoute, type RouteCommand, toMovementInput } from "../LearnedRoutes";

/** A run-up state matches the bot within this far, units. */
const JOIN_DISTANCE = 16;
/** ... and this much speed difference, units/s. */
const JOIN_SPEED = 60;
/** ... and this much heading difference, radians. */
const JOIN_HEADING = (10 * Math.PI) / 180;
/** The run-in starts this far behind the mark, units. */
export const ENTRY_BACK = 192;
/** Landed when this close to the route's landing (as the sequence judges it). */
const LANDING_RADIUS = 64;
const LANDING_HEIGHT = 48;
/** Ticks after the script in which a landing counts. */
const LANDING_TICKS = 40;

export interface RunUpState {
  position: Vec3;
  velocity: Vec3;
}

export interface SimWorld {
  collision: CollisionWorld;
  triggers: readonly TriggerVolume[];
}

/** How many leading commands are the plain run-up (all equal to the first). */
export function runUpLength(commands: readonly RouteCommand[]): number {
  const first = commands[0];
  // A run-up is plain running: a jump or a crouch is already the trick.
  if (!first || (first.buttons & (InputButtons.JUMP | InputButtons.CROUCH)) !== 0) return 0;
  let n = 0;
  while (
    n < commands.length &&
    commands[n].buttons === first.buttons &&
    commands[n].forward === first.forward &&
    commands[n].right === first.right &&
    commands[n].yaw === first.yaw
  )
    n++;
  // A script that is all run-up has no trick to join.
  return n === commands.length ? 0 : n;
}

/** The state after each run-up command, replayed from standing on the mark. */
export function runUpStates(route: LearnedRoute, commands: readonly RouteCommand[], world: SimWorld): RunUpState[] {
  const length = runUpLength(commands);
  const profile = new MovementProfile();
  profile.resetPhysicsState(true);
  profile.setTriggerVolumes(world.triggers as TriggerVolume[]);
  let position = { ...route.start };
  let velocity = { x: 0, y: 0, z: 0 };
  const out: RunUpState[] = [];
  for (let i = 0; i < length; i++) {
    const result = profile.simulate(position, velocity, toMovementInput(commands[i], i + 1), 1 / 125, world.collision);
    position = result.position;
    velocity = result.velocity;
    out.push({ position: { ...position }, velocity: { ...velocity } });
  }
  return out;
}

/** The run-up state the bot matches, by index, or null. */
export function findJoin(runUp: readonly RunUpState[], position: Vec3, velocity: Vec3): number | null {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed < 1) return null;
  let best: number | null = null;
  let bestDistance = JOIN_DISTANCE;
  for (let k = 0; k < runUp.length; k++) {
    const state = runUp[k];
    const distance = Math.hypot(state.position.x - position.x, state.position.z - position.z);
    if (distance > bestDistance || Math.abs(state.position.y - position.y) > 18) continue;
    const runSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    if (Math.abs(runSpeed - speed) > JOIN_SPEED || runSpeed < 1) continue;
    const off = Math.atan2(
      state.velocity.x * velocity.z - state.velocity.z * velocity.x,
      state.velocity.x * velocity.x + state.velocity.z * velocity.z,
    );
    if (Math.abs(off) > JOIN_HEADING) continue;
    best = k;
    bestDistance = distance;
  }
  return best;
}

/** Whether the script after run-up state `k`, from the bot's exact state, lands where the route lands. */
export function joinLands(
  route: LearnedRoute,
  commands: readonly RouteCommand[],
  k: number,
  start: { position: Vec3; velocity: Vec3 },
  world: SimWorld,
): boolean {
  const profile = new MovementProfile();
  profile.resetPhysicsState(true);
  profile.setTriggerVolumes(world.triggers as TriggerVolume[]);
  let position = { ...start.position };
  let velocity = { ...start.velocity };
  const rest = commands.slice(k + 1);
  for (let i = 0; i < rest.length + LANDING_TICKS; i++) {
    const command = rest[Math.min(i, rest.length - 1)];
    // After the script the bot stands still: no keys.
    const input = toMovementInput(
      i < rest.length ? command : { ...command, forward: 0, right: 0, buttons: 0 },
      k + 2 + i,
    );
    const result = profile.simulate(position, velocity, input, 1 / 125, world.collision);
    position = result.position;
    velocity = result.velocity;
    if (
      i >= rest.length / 2 &&
      result.grounded &&
      Math.hypot(position.x - route.landing.x, position.z - route.landing.z) <= LANDING_RADIUS &&
      Math.abs(position.y - route.landing.y) <= LANDING_HEIGHT
    )
      return true;
  }
  return false;
}

/**
 * Where the bot will be after `ticks` more of `command`: the snapshot it decides
 * on is that far behind the server, and it keeps sprinting meanwhile.
 */
export function predict(
  start: { position: Vec3; velocity: Vec3 },
  command: RouteCommand,
  ticks: number,
  world: SimWorld,
): { position: Vec3; velocity: Vec3; grounded: boolean } {
  const profile = new MovementProfile();
  profile.resetPhysicsState(true);
  profile.setTriggerVolumes(world.triggers as TriggerVolume[]);
  let position = { ...start.position };
  let velocity = { ...start.velocity };
  let grounded = true;
  for (let i = 0; i < ticks; i++) {
    const result = profile.simulate(position, velocity, toMovementInput(command, i + 1), 1 / 125, world.collision);
    position = result.position;
    velocity = result.velocity;
    grounded = result.grounded;
  }
  return { position, velocity, grounded };
}

/** Where the run-in starts: behind the mark on the route's line. */
export function entryPoint(route: LearnedRoute): Vec3 {
  return {
    x: route.start.x - Math.sin(route.yaw) * ENTRY_BACK,
    y: route.start.y,
    z: route.start.z - Math.cos(route.yaw) * ENTRY_BACK,
  };
}
