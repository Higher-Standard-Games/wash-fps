import type { MovementInput } from "../../../engine/network/systems/movement/MovementProfile";
import { type CollisionWorld, Contents } from "../../../shared/collision/CollisionWorld";
import { MovementProfile } from "../simulation/MovementProfile";
import { type BotInput, travelYaw } from "./BotBrain";
import { InputButtons } from "./BotConfig";
import type { BotSelf, Vec3 } from "./BotGameState";
import { PHYSICS } from "./BotMovementProfile";

export interface LedgeSlideJumpPlan {
  inputs: BotInput[];
  landing: Vec3;
  jumpTick: number;
  takeoffSpeed: number;
}

/** Prove a slide-to-edge jump and its landing with the authoritative 125 Hz mover. */
export function planLedgeSlideJump(
  self: BotSelf,
  proposed: BotInput,
  target: Vec3,
  collision: CollisionWorld,
): LedgeSlideJumpPlan | null {
  const speed = Math.hypot(self.velocity.x, self.velocity.z);
  if (
    !self.isGrounded ||
    self.isSliding ||
    speed < PHYSICS.SLIDE_MIN_SPEED ||
    Math.abs(target.y - self.position.y) > 160
  )
    return null;
  const yaw = travelYaw(proposed);
  const direction = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  if ((self.velocity.x * direction.x + self.velocity.z * direction.z) / speed < 0.96) return null;
  let edgeDistance = 0;
  for (let distance = 16; distance <= 224; distance += 8) {
    const point = {
      x: self.position.x + direction.x * distance,
      y: self.position.y,
      z: self.position.z + direction.z * distance,
    };
    const floor = collision.trace(point, { ...point, y: point.y - 64 });
    if (!floor.hit || floor.fraction >= 1) {
      edgeDistance = distance;
      break;
    }
  }
  if (edgeDistance < speed * 0.14 + 24) return null;
  const profile = new MovementProfile({ wallJumpEnabled: false, ledgeGrabEnabled: false });
  profile.resetPhysicsState(true);
  let position = { ...self.position };
  let velocity = { ...self.velocity };
  let sliding = false;
  let jumpTick = -1;
  let takeoffSpeed = 0;
  let airborne = false;
  let stable = 0;
  const inputs: BotInput[] = [];
  for (let tick = 0; tick < 150; tick++) {
    const progress = (position.x - self.position.x) * direction.x + (position.z - self.position.z) * direction.z;
    const jump =
      jumpTick < 0 &&
      sliding &&
      tick >= 14 &&
      edgeDistance - progress <= Math.max(24, (Math.hypot(velocity.x, velocity.z) * 2) / 125);
    const buttons =
      InputButtons.FORWARD |
      InputButtons.SPRINT |
      (jumpTick < 0 && !jump ? InputButtons.CROUCH : 0) |
      (jump ? InputButtons.JUMP : 0);
    const input: MovementInput = {
      direction,
      viewAngles: { pitch: self.pitch, yaw: self.yaw },
      buttons,
      sequence: tick,
      isPressed(button: number) {
        return (this.buttons & button) !== 0;
      },
    };
    const result = profile.simulate(position, velocity, input, 1 / 125, collision);
    position = result.position;
    velocity = result.velocity;
    sliding = result.isSliding ?? false;
    if (collision.pointContents(position) & (Contents.LAVA | Contents.SLIME)) return null;
    if (jump) {
      jumpTick = tick;
      takeoffSpeed = Math.hypot(velocity.x, velocity.z);
    }
    inputs.push({
      direction: { x: 0, y: 0, z: 1 },
      yaw: self.yaw,
      pitch: self.pitch,
      moveYaw: yaw,
      buttons,
      weaponSlot: 0,
    });
    if (!result.grounded) {
      if (jumpTick < 0) return null;
      airborne = true;
    }
    if (airborne && result.grounded) {
      if (Math.hypot(position.x - target.x, position.z - target.z) > 96 || Math.abs(position.y - target.y) > 64)
        return null;
      if (++stable >= 2) return { inputs, landing: { ...position }, jumpTick, takeoffSpeed };
    }
  }
  return null;
}
