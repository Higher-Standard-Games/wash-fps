/**
 * FollowedViewWeapon — the gun in front of you while you watch someone.
 *
 * Demo playback and live spectating both put the camera behind another
 * player's eyes, and both owe the viewer the picture that player had: their
 * weapon, switched when they switch, flashing and kicking when they shoot,
 * gone while they are dead, and swaying with their stride. This is that
 * picture, written once for both. The caller owns the WeaponViewManager and
 * the clock; this decides what the weapon does.
 *
 * Stopping leaves visibility alone. When a live spectate ends because we
 * respawned, our own weapon is coming back up through the respawn path, and a
 * hide from here would race it.
 */

import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { InterpolatedEntity } from "../../../engine/network/client/SnapshotBuffer";
import type { WeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import { canonicalWeaponId } from "../shared/entities/definitions/weapons/WeaponsTable";
import { type DemoPovClock, type DemoPovPresentation, DemoPovState } from "./DemoPovState";

export class FollowedViewWeapon {
  private entityId: string | null = null;
  private dead = false;
  /** Set by follow(): the first weapon shown is already in hand, not switched to. */
  private cut = true;
  private readonly stride = new DemoPovState();
  private pose: DemoPovPresentation | null = null;
  private aiming = false;

  /** `view` resolves the weapon view to drive, or null while there is none. */
  constructor(private readonly view: () => WeaponViewManager | null) {}

  /**
   * The clock for live play: wall time in milliseconds. The stride divides
   * elapsed ticks by the tick rate, so a rate of 1000 makes each tick a
   * millisecond.
   */
  static liveClock(nowMs: number): DemoPovClock {
    return { playheadTick: nowMs, tickRate: 1000, paused: false, discontinuityId: 0 };
  }

  get followedEntityId(): string | null {
    return this.entityId;
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** Eye height and camera sway for the watched player, from the last motion update. */
  get presentation(): DemoPovPresentation | null {
    return this.pose;
  }

  /** Start watching `entityId`, or stop with null. */
  follow(entityId: string | null, dead = false): void {
    this.entityId = entityId;
    this.dead = dead;
    this.cut = true;
    this.stride.reset();
    this.pose = null;
    const view = this.readyView();
    if (!view) return;
    view.clearFollowedBob();
    if (entityId) view.setVisible(!dead);
  }

  /**
   * Show the watched player's weapon. Compared against what the view is
   * displaying rather than what was last asked for, so it can be fed every
   * snapshot and heals itself after a target change. `instant` skips the
   * switch animation, for a seek.
   */
  showWeapon(weaponId: string, instant = false): void {
    const view = this.readyView();
    if (!view || !this.entityId) return;
    const weapon = canonicalWeaponId(weaponId);
    if (view.getDisplayedWeaponId() !== weapon) {
      if (instant || this.cut) {
        view.cancelSwitch();
        view.loadWeapon(weapon).catch(ignoreLoadFailure);
      } else {
        view.switchWeaponAnimated(weapon).catch(ignoreLoadFailure);
      }
    }
    this.cut = false;
    view.setVisible(!this.dead);
  }

  /** They fired: the flash and kick their own screen showed. */
  fired(): void {
    if (!this.entityId || this.dead) return;
    this.readyView()?.presentFire();
  }

  /** They died or came back, and their weapon with them. */
  setDead(dead: boolean): void {
    if (!this.entityId || dead === this.dead) return;
    this.dead = dead;
    this.readyView()?.setVisible(!dead);
  }

  /**
   * Advance their stride from the sample they are drawn with, sway the weapon
   * with it, and return the camera's share of the same motion.
   */
  updateMotion(sample: InterpolatedEntity, clock: DemoPovClock): DemoPovPresentation | null {
    if (!this.entityId) return null;
    const pose = this.stride.update(this.entityId, sample, clock);
    this.pose = pose;
    this.readyView()?.updateFollowedBob({
      aiming: this.aiming,
      deltaTime: pose.demoDeltaSeconds,
      grounded: pose.grounded,
      horizontalSpeed: pose.horizontalSpeed,
      velocityY: pose.velocityY,
      landingVelocity: pose.landingVelocity,
      bobCycle: pose.bobCycle,
    });
    return pose;
  }

  /**
   * Whether they are aiming down sights: their gun comes up to the sights and
   * the view zooms. Known where a recording carries their buttons.
   */
  setAiming(aiming: boolean): void {
    this.aiming = aiming;
    this.stride.setAiming(aiming);
  }

  /** Where their projectile leaves the barrel on screen, while their weapon is up. */
  muzzleFor(position: Vector3, velocity: Vector3): Vector3 | null {
    if (!this.entityId || this.dead) return null;
    return this.readyView()?.getProjectileMuzzlePosition(position, velocity) ?? null;
  }

  /** Where their beam leaves the barrel on screen, while their weapon is up. */
  beamMuzzle(): Vector3 | null {
    if (!this.entityId || this.dead) return null;
    return this.readyView()?.getMuzzleWorldPosition() ?? null;
  }

  private readyView(): WeaponViewManager | null {
    const view = this.view();
    return view?.isReady ? view : null;
  }
}

function ignoreLoadFailure(): void {
  // A weapon that cannot load leaves the previous model up. Not worth
  // interrupting a spectator over.
}
