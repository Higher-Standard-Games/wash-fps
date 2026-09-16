/**
 * Knockback air drag, shared by the server tick and client prediction.
 *
 * An impulse is plain velocity and travels in the snapshot like any other.
 * What does not is how far into its drag window the body is, so both sides step
 * one age through this one function: identical velocity, grounded state and
 * age must give identical drag, or replay diverges from the server.
 */
import type { Vec3 } from "../../../engine/network/components/TransformComponent";

/** Steps after an impulse before drag begins (~0.4s at 125Hz). */
export const KB_DRAG_DELAY_TICKS = 50;
/** Steps over which drag ramps from nothing to full strength (~0.6s at 125Hz). */
export const KB_DRAG_RAMP_TICKS = 75;
/** Horizontal speed multiplier per step at full drag (0.96 loses ~4% a step). */
const KB_HORIZ_DRAG = 0.96;
/** Extra downward acceleration at full drag, in units/s². */
const KB_EXTRA_GRAVITY = 600;

/**
 * A valid drag age, or null. Age 0 is the impulse's own step; anything past the
 * window, fractional or negative is not an age, including a value off the wire.
 */
export function readKnockbackAge(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= KB_DRAG_DELAY_TICKS + KB_DRAG_RAMP_TICKS
    ? value
    : null;
}

/**
 * Apply one step of drag at `age`, BEFORE that step's movement. Returns the age
 * while drag is live, or null once a landing or the end of the window ends it;
 * callers drop the impulse on null and pass `age + 1` on the next step.
 */
export function applyKnockbackDrag(velocity: Vec3, grounded: boolean, age: number, dt: number): number | null {
  if (grounded || readKnockbackAge(age) === null) return null;
  if (age < KB_DRAG_DELAY_TICKS) return age;
  const ramp = (age - KB_DRAG_DELAY_TICKS) / KB_DRAG_RAMP_TICKS;
  const strength = ramp * ramp;
  const multiplier = 1 - strength * (1 - KB_HORIZ_DRAG);
  velocity.x *= multiplier;
  velocity.z *= multiplier;
  velocity.y -= KB_EXTRA_GRAVITY * strength * dt;
  return age;
}
