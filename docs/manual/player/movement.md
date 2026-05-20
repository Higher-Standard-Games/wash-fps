# Movement

Q3-style core with Warsow extensions. All defaults below come from `simulation/MovementProfile.ts` and run identically on client (predicted) and server (authoritative).

## Core Numbers

| Value | Default | Notes |
|-------|---------|-------|
| Max ground speed | 280 u/s | `maxSpeed`; the soft cap, before air-strafe gains |
| Sprint / run speed | 400 u/s | `runSpeed`; held Shift |
| Ground acceleration | 10 | `groundAcceleration` |
| Air acceleration | 1 | `airAcceleration`; this is what makes air strafing work |
| Max added air speed per tick | 30 u/s | `maxAirSpeed`; the per-tick cap |
| Friction | 6 | `friction`; ground deceleration |
| Stop speed | 100 | `stopSpeed`; below this, friction maxes out |
| Gravity | 1000 u/s² | `gravity` |
| Falling-gravity multiplier | 1.25× | `fallingGravityMultiplier` — pulls harder during downward arc |
| Jump velocity | 320 u/s | `jumpVelocity` |
| Crouch speed multiplier | 0.5× | `crouchMultiplier` |
| Step height | 18 u | `stepHeight`; auto-climb threshold |
| Air-control angle | 150° / sec | `airControl`; how fast you can re-aim mid-air without losing speed |

## Strafe Jumping (Air Strafing)

The classic Q3 technique. Mid-air, hold the strafe key (A or D) in the direction you want to turn and move your mouse the same way. The air-acceleration math gains you a small velocity vector in the new direction *without subtracting* the existing one — so over several mid-air corrections you accumulate net speed.

Rules of thumb:

- Keep your *crosshair direction* and your *velocity direction* slightly different. Strafe input bridges the gap.
- Holding **W** while strafing actually hurts your gains — it makes the math project velocity onto your forward axis.
- The per-tick gain is capped (`maxAirSpeed: 30`), so jamming the mouse won't get you anywhere faster than smooth, steady turns.

## Bunny Hopping

Chain jumps to keep your accumulated air-strafe speed. The key is timing:

- Hit **Space** the instant you touch the ground — friction only applies between landing and next jump.
- Don't release directional keys; you'll bleed speed even in one ground frame.
- Many players bind Space to mousewheel-down for easier timing.

## Wall Jump

A Warsow-style mechanic. You can kick off a wall to gain height and a momentum boost.

| Value | Default | Notes |
|-------|---------|-------|
| Wall-jump height | 280 u/s | `wallJumpHeight`; vertical impulse |
| Bounce factor | 1.2× | `wallJumpBounce`; reflected horizontal velocity |
| Reach | 20 u | `wallJumpReach`; how close you need to be |
| Cooldown | 1.0 s | `wallJumpCooldown` |
| Minimum height above floor | 32 u | `wallJumpMinHeight`; can't wall-jump while standing |
| Charge time | 0.2 s | `wallJumpChargeTime`; hold jump near a wall to charge |
| Charge boost | 1.5× | `wallJumpBoost`; multiplier when jumping out of a charged state |

Practical: approach a wall, **hold Space** as you get close, the screen tilts slightly while charging, then release Space to launch with the boost. Look in the direction you want to go before releasing.

## Ledge Grab

Auto-grab + pull-up on ledges within reach during a fall.

| Value | Default | Notes |
|-------|---------|-------|
| Reach | 32 u | `ledgeReach` |
| Maximum grabable ledge height | 64 u | `ledgeHeight` |
| Minimum fall velocity to trigger | -50 u/s | `ledgeMinFall`; need to actually be falling |
| Grab timeout | 2.0 s | `ledgeTimeout`; how long you can hang |
| Pull-up duration | 0.5 s | `ledgePullTime` |

Practical: jump or fall toward a ledge with a grabable lip. The game grabs automatically; the camera tilts and your view rises during the pull-up. You can cancel the grab early by jumping.

## Crouchslide

Sprint into a crouch to slide along the ground with a temporary speed bonus.

| Value | Default | Notes |
|-------|---------|-------|
| Duration | 800 ms | `slideDuration`; ends when this elapses or you cancel |
| Speed multiplier (entry) | 1.4× | `slideSpeedMultiplier`; instant boost on slide-start |
| Decay | 0.5 per tick | `slideDecay`; how fast the bonus fades |
| Jump-out boost | 1.3× | `slideJumpBoost`; multiplied to launch velocity if you jump during slide |
| Minimum entry speed | 375 u/s | `slideMinSpeed`; below this you just crouch normally |
| Friction while sliding | 0.1 | `slideFriction`; much lower than normal ground friction |
| Cooldown between slides | 1.5 s | `slideCooldown` |

Practical: build speed (run + strafe jumps), tap **Ctrl** while at full sprint to enter slide, then either ride it out for the speed boost or jump out to chain into more strafe gains. The camera tilts in the slide direction.

## Tips & Common Mistakes

- **Don't hold W** during strafe jumps. The air-strafe gain comes from your *mouse* + *side keys*, not forward.
- **Pre-jump before charging a wall-jump.** Your wall-jump uses the velocity you arrive with as the base.
- **Crouchslide is for chaining, not braking.** The speed boost is your reward; if you slide into a wall you lose it instantly.
- **Bunny-hop landing windows are tighter than they feel.** Practice on `aerowalk_b1` or similar parkour maps before competitive servers.
- **Movement is identical on client and server.** If something feels off, it's network jitter or packet loss, not your inputs being ignored — check NetGraph (see [HUD](./hud.md)).
