import { describe, expect, it } from "vitest";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import type { MovementInput } from "../../../../engine/network/systems/movement/MovementProfile";
import { Slide } from "../Slide";

/**
 * Crouch view-offset + slide-exit tilt transitions must be pure functions of
 * the sim clock. The old per-call accumulation (`offset += delta * 0.2`,
 * `slidePhase *= 0.85`) advanced once per simulate() CALL, so reconciliation
 * replays fast-forwarded the get-up animation into a flick (user report,
 * 2026-07-10 — same bug class as the v0.9.16 slide-timer fix).
 */

function input(buttons = 0): MovementInput {
  return {
    direction: { x: 0, y: 0, z: 0 },
    viewAngles: { pitch: 0, yaw: 0 },
    buttons,
    isPressed: (b: number) => (buttons & b) !== 0,
  } as MovementInput;
}

const CROUCH = input(InputButtons.CROUCH);
const NONE = input(0);

describe("crouch view-offset transition (sim-clock anchored)", () => {
  it("is idempotent at a fixed sim time — replays cannot fast-forward it", () => {
    const slide = new Slide();
    // Fully crouch (past the down duration)
    slide.updateCrouch(CROUCH, 0);
    slide.updateCrouch(CROUCH, 200);
    expect(slide.crouchViewOffset).toBe(-24);

    // Start standing up; sample mid-transition…
    slide.updateCrouch(NONE, 208);
    slide.updateCrouch(NONE, 300);
    const mid = slide.crouchViewOffset;
    expect(mid).toBeLessThan(-1);
    expect(mid).toBeGreaterThan(-24);

    // …then "replay" the same sim time ten more times (reconciliation).
    for (let i = 0; i < 10; i++) slide.updateCrouch(NONE, 300);
    expect(slide.crouchViewOffset).toBe(mid); // unchanged — no flick
  });

  it("standing up takes the full deliberate duration (~260ms), not a handful of ticks", () => {
    const slide = new Slide();
    slide.updateCrouch(CROUCH, 0);
    slide.updateCrouch(CROUCH, 200);

    slide.updateCrouch(NONE, 208); // flip anchor
    slide.updateCrouch(NONE, 208 + 130); // halfway through CROUCH_UP_MS
    expect(slide.crouchViewOffset).toBeCloseTo(-12, 1); // smoothstep(0.5) = 0.5

    slide.updateCrouch(NONE, 208 + 260);
    expect(slide.crouchViewOffset).toBe(0); // fully up exactly at duration
  });

  it("crouching down is snappier than standing up", () => {
    const down = new Slide();
    down.updateCrouch(NONE, 0);
    down.updateCrouch(CROUCH, 8); // flip → down anchor at 8
    down.updateCrouch(CROUCH, 8 + 140);
    expect(down.crouchViewOffset).toBe(-24); // done at 140ms

    const up = new Slide();
    up.updateCrouch(CROUCH, 0);
    up.updateCrouch(CROUCH, 200);
    up.updateCrouch(NONE, 208);
    up.updateCrouch(NONE, 208 + 140); // same elapsed as the down test
    expect(up.crouchViewOffset).toBeLessThan(-4); // still visibly rising
  });

  it("reversing mid-transition continues from the current offset (no pop)", () => {
    const slide = new Slide();
    slide.updateCrouch(CROUCH, 0);
    slide.updateCrouch(CROUCH, 200); // fully down
    slide.updateCrouch(NONE, 208); // start rising
    slide.updateCrouch(NONE, 300); // mid-rise
    const mid = slide.crouchViewOffset;

    slide.updateCrouch(CROUCH, 308); // re-crouch mid-rise
    // Immediately after the flip the offset continues from `mid` (t≈0).
    expect(Math.abs(slide.crouchViewOffset - mid)).toBeLessThan(1.5);
  });
});

describe("slide-exit camera tilt fade (sim-clock anchored)", () => {
  const config = {
    slideMinSpeed: 375,
    slideSpeedMultiplier: 1.4,
    slideDuration: 800,
    slideDecay: 0.5,
    slideJumpBoost: 1.3,
    slideCooldown: 1500,
    jumpVelocity: 320,
    // biome-ignore lint/suspicious/noExplicitAny: minimal config for Slide
  } as any;

  it("fades over the anchored duration and is idempotent under replay", () => {
    const slide = new Slide();
    const vel = { x: 500, y: 0, z: 0 };

    // Enter slide (grounded, crouched, fast), build some phase.
    slide.update(vel, CROUCH, true, 0, 0.008, config);
    expect(slide.isSliding).toBe(true);
    slide.update(vel, CROUCH, true, 400, 0.008, config);
    expect(slide.slidePhase).toBeGreaterThan(0.9);

    // Release crouch → exit; phase captured at exit.
    slide.update(vel, NONE, true, 408, 0.008, config);
    expect(slide.isSliding).toBe(false);

    // Mid-fade sample, then replay the same sim time repeatedly.
    slide.update(vel, NONE, true, 500, 0.008, config);
    const mid = slide.slidePhase;
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(1);
    for (let i = 0; i < 10; i++) slide.update(vel, NONE, true, 500, 0.008, config);
    expect(slide.slidePhase).toBe(mid); // no replay fast-forward

    // Fully gone after the fade window.
    slide.update(vel, NONE, true, 408 + 260, 0.008, config);
    expect(slide.slidePhase).toBe(0);
  });
});
