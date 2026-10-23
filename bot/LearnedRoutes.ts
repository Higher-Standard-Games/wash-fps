/**
 * Learned routes: movement tricks recorded by a player (`training_demo`) and
 * verified by re-simulation (`npm run bot:learn`), stored per map in
 * `config/bot-routes/<map>.json`. A route is a script of exact per-tick
 * commands from a standstill at `start` to a landing at `landing`; the bot
 * walks to `start`, stops, faces `yaw` and sends the script one command per
 * server tick. The movement simulation is deterministic, so a verified script
 * lands where it landed in verification.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { InputButtons } from "../../../engine/network/components/InputComponent";
import type { MovementInput } from "../../../engine/network/systems/movement/MovementProfile";
import type { TriggerVolume } from "../../../shared/bsp/TriggerTable";
import type { CollisionWorld } from "../../../shared/collision/CollisionWorld";
import type { Vec3 } from "../shared/bsp/BspDataLoader";
import { MovementProfile } from "../simulation/MovementProfile";

/** One command as the server applies it: wish direction in world space, view, buttons. */
export interface RouteCommand {
  /** World-space Z of the wish direction. */
  forward: number;
  /** World-space X of the wish direction. */
  right: number;
  yaw: number;
  pitch: number;
  buttons: number;
}

/** Run-length encoded commands: `[count, forward, right, yaw, pitch, buttons]`. */
export type EncodedScript = Array<[number, number, number, number, number, number]>;

export interface LearnedRoute {
  /** Stable id: `<demo file>@<takeoff tick>`. */
  id: string;
  kind: "wall_jump" | "jump";
  /** Standing origin to stop at before the script starts. */
  start: Vec3;
  /** Facing at the start, radians. */
  yaw: number;
  /** Standing origin where the script lands. */
  landing: Vec3;
  /** Script length in ticks. */
  ticks: number;
  script: EncodedScript;
  /** Wall jumps in the recorded flight. */
  wallJumps: number;
  /** How far the verifying replay landed from the recorded landing, units. */
  replayError: number;
  /** Verifying replays from nudged starts that landed, of those tried. */
  robustness: { landed: number; tried: number };
  source: { demo: string; tick: number };
}

export interface LearnedRouteFile {
  version: 1;
  map: string;
  routes: LearnedRoute[];
}

/** Where learned routes live, relative to the project root. */
export const LEARNED_ROUTES_DIR = path.join("config", "bot-routes");

const round = (value: number, digits: number) => Number(value.toFixed(digits));

export function encodeScript(commands: readonly RouteCommand[]): EncodedScript {
  const encoded: EncodedScript = [];
  for (const c of commands) {
    const row: [number, number, number, number, number, number] = [
      1,
      round(c.forward, 4),
      round(c.right, 4),
      round(c.yaw, 4),
      round(c.pitch, 4),
      c.buttons,
    ];
    const last = encoded[encoded.length - 1];
    if (last?.slice(1).every((v, i) => v === row[i + 1])) last[0]++;
    else encoded.push(row);
  }
  return encoded;
}

export function decodeScript(script: EncodedScript): RouteCommand[] {
  const commands: RouteCommand[] = [];
  for (const [count, forward, right, yaw, pitch, buttons] of script) {
    for (let i = 0; i < count; i++) commands.push({ forward, right, yaw, pitch, buttons });
  }
  return commands;
}

/** A command as the movement simulation takes it. `step` is the tick, the profile's clock. */
export function toMovementInput(command: RouteCommand, step: number): MovementInput {
  return {
    direction: { x: command.right, y: 0, z: command.forward },
    viewAngles: { pitch: command.pitch, yaw: command.yaw },
    buttons: command.buttons,
    sequence: step,
    simStep: step,
    isPressed(button: number): boolean {
      return (this.buttons & button) !== 0;
    },
  } as MovementInput;
}

/** A command that runs flat out along a horizontal direction. */
export function runCommand(direction: { x: number; z: number }): RouteCommand {
  return {
    forward: direction.z,
    right: direction.x,
    yaw: Math.atan2(direction.x, direction.z),
    pitch: 0,
    buttons: InputButtons.FORWARD | InputButtons.SPRINT,
  };
}

export interface ReplayResult {
  position: Vec3;
  grounded: boolean;
  /** Origin at every tick. */
  path: Vec3[];
  /** On the ground at every tick. */
  groundedPath: boolean[];
}

/** Replay commands from a state with the game's own movement. */
export function replayCommands(
  collision: CollisionWorld,
  triggers: readonly TriggerVolume[],
  start: { position: Vec3; velocity: Vec3; grounded: boolean },
  commands: readonly RouteCommand[],
): ReplayResult {
  const profile = new MovementProfile();
  profile.resetPhysicsState(start.grounded);
  profile.setTriggerVolumes(triggers as TriggerVolume[]);
  let position = { ...start.position };
  let velocity = { ...start.velocity };
  let grounded = start.grounded;
  const pathTaken: Vec3[] = [];
  const groundedPath: boolean[] = [];
  commands.forEach((command, i) => {
    const result = profile.simulate(position, velocity, toMovementInput(command, i + 1), 1 / 125, collision);
    position = result.position;
    velocity = result.velocity;
    grounded = result.grounded;
    pathTaken.push({ ...position });
    groundedPath.push(grounded);
  });
  return { position, grounded, path: pathTaken, groundedPath };
}

/** The routes learned for a map, or none. */
export function loadLearnedRoutes(mapName: string, root = process.cwd()): LearnedRoute[] {
  const file = path.join(root, LEARNED_ROUTES_DIR, `${mapName}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as LearnedRouteFile;
    return data.version === 1 && Array.isArray(data.routes) ? data.routes : [];
  } catch (error) {
    console.warn(`[LearnedRoutes] Ignoring unreadable ${file}:`, error);
    return [];
  }
}

export function saveLearnedRoutes(mapName: string, routes: LearnedRoute[], root = process.cwd()): string {
  const dir = path.join(root, LEARNED_ROUTES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${mapName}.json`);
  const data: LearnedRouteFile = { version: 1, map: mapName, routes };
  fs.writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`);
  return file;
}
