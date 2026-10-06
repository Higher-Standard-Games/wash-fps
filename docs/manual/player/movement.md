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

Practical: build speed (run + strafe jumps), tap **Ctrl** while at full sprint to enter slide, then either ride it out for the speed boost or jump out to chain into more strafe gains. The camera tilts in the slide direction. Standing up from a slide/crouch is a **deliberate ~260 ms rise** (crouching down is snappier at ~140 ms) — both are sim-clock anchored, so they never "flick" during reconciliation.

## Teleporters

Maps place **`trigger_teleport`** brush volumes linked to a **`misc_teleporter_dest`** exit point. Walk into one and you're instantly relocated to the exit, facing the exit's authored direction.

- **Momentum carries.** Your full 3D speed is redirected along the exit yaw (Warsow-style) — so **falling into a drop-in teleporter converts your fall speed into exit speed.** Dive in with speed and you rocket out the other side.
- **Predicted, no snap.** Teleport is evaluated in the shared movement code, so the client predicts it — you don't rubber-band, and your view snaps cleanly to the exit direction the instant you cross the trigger.
- **Telefrag.** If someone is standing on the exit when you come through, they die instantly and you get the frag (Q3 rule). Camping a teleporter exit is dangerous.
- A washoi afterimage "ghost" is left at both the entry and the exit — a readable tell that a teleport just happened (and where you went).

## Jumppads

**`trigger_push`** brushes launch you at a fixed target (a `target_position`) — the classic accelerator pad. The launch is solved so your arc lands on the pad's target, and it's client-predicted like everything else. Velocity is **replaced**, not added, so you can't "pre-load" a pad by jumping into it — step on, get launched, and aim your air-strafe on the way up.

## Ladders

Brushes tagged `SURF_LADDER` are climbable. A ladder is a volume, not a wall: you climb whenever your body overlaps it, so you don't need to face it or press into it.

| Value | Default | Notes |
|-------|---------|-------|
| Climb speed | 168 u/s | `climbSpeed`; up or down, well under run speed |
| Acceleration / friction | 30 / 20 | releasing the keys stops you on the rung within a few units |
| Sideways speed | 0.4× | `lateralScale`; shuffle along a ladder |
| Jump-off speed | 270 u/s | `detachUp`; jump to leave a ladder |
| Re-grab cooldown | 400 ms | `detachCooldownMs`; after you let go |

- **Walking past the foot of a ladder doesn't grab you.** On the ground you only attach when you actively move up into it; in the air, touching it is enough.
- Climbing is part of the shared movement code, so it is predicted on the client like everything else.

## Water and Other Liquids

Water, slime and lava are volumes with four depth levels: **0** dry, **1** feet wet (you still walk, with drag), **2** waist deep (you swim), **3** fully submerged (you swim and the air clock runs).

| Value | Default | Notes |
|-------|---------|-------|
| Swim speed | 0.5× | `swimScale`; wading scales smoothly between walking and this |
| Water acceleration | 4 | `waterAcceleration` |
| Idle sink | 60 u/s | `idleSinkSpeed`; you drift down with no input |
| Water-jump (climb out) | 200 forward, 350 up | `waterJumpForward` / `waterJumpUp`; assisted climb onto a ledge, 2 s of reduced control |

Swim in the direction you are looking: look up and hold forward to rise. **Jump** and **crouch** swim straight up and down regardless of where you look. While swimming you lie flat, so your hitbox is shorter (28 u instead of 56 u) and slides into low gaps.

| Hazard | Damage |
|--------|--------|
| **Drowning** | 12 s of air once your head goes under; then 2 damage, rising by 2 each second, capped at 15 per second |
| **Slime** | 10 per second per depth level |
| **Lava** | 30 per second per depth level, roughly a two-second death at full health |

Air refills as soon as your head is clear. Water also has splash effects and sound; these are presentation only and don't change gameplay.

## Lifts, Doors and Movers

Moving brush models (`func_plat`, doors and similar) are simulated on the server, predicted on the client and rewound for hit registration, so standing on an elevator feels the same online as offline.

- **You ride them.** Players, corpses and dropped weapons all travel with the floor.
- **Crushing.** A mover that is blocked by a player damages them (20 hits per second, using the mover's own `dmg` value; 0 disables it). Most movers reverse when blocked; ones with the **crusher** flag keep pushing. Crush damage counts as world damage, like drowning, and is never credited to another player.
- Activation, wait times and sounds are authored in the map.

## Fall Damage

Falling too far hurts. Distance is measured **floor-to-floor** in map units (a normal jump arc never counts — only the height you actually drop between surfaces):

| Drop | Effect |
|------|--------|
| **< 256u** | Safe (about five jump-heights) |
| **256–384u** | Ramps 0→100 damage, absorbed by armor like a normal hit |
| **384–512u** | Drains all armor and leaves you at exactly 1 HP |
| **≥ 512u** | Fatal — a self-frag |

**Hold crouch as you land** to soften the effective drop (`sv_falldamage_crouchsoften`, default 64u). Servers can retune the bands or disable fall damage entirely (`sv_falldamage 0`); the values above are the defaults (`sv_falldamage_min` / `_full` / `_fatal`). Post-spawn drops and mid-fall teleports never count.

## Tips & Common Mistakes

- **Don't hold W** during strafe jumps. The air-strafe gain comes from your *mouse* + *side keys*, not forward.
- **Pre-jump before charging a wall-jump.** Your wall-jump uses the velocity you arrive with as the base.
- **Crouchslide is for chaining, not braking.** The speed boost is your reward; if you slide into a wall you lose it instantly.
- **Bunny-hop landing windows are tighter than they feel.** Practice on `aerowalk_b1` or similar parkour maps before competitive servers.
- **Movement is identical on client and server.** If something feels off, it's network jitter or packet loss, not your inputs being ignored — check NetGraph (see [HUD](./hud.md)).
