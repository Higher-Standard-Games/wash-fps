/**
 * The FIGHT and DODGE states: aim with and without lead, the weapon and its
 * combos, charged shots, the fight's moves (strafing, cover peeks, keeping
 * the high ground, the slide-blade lunge), and readying a weapon for an enemy
 * heard before it is seen.
 */

import { DEFAULT_VIEWHEIGHT } from "../../../../engine/physics/PlayerPhysicsConstants";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../../shared/server/simulation/physics/constants";
import { scaledBodyHeight } from "../../shared/BodyScale";
import { selectGametypeHabits } from "../../shared/bot/WeightProfiles";
import { wrapAngle } from "../BotAimController";
import type { BotInput } from "../BotBrain";
import { BotState, travelYaw } from "../BotBrain";
import { BotCombatMovement, findHighGround } from "../BotCombatMovement";
import type { BotDifficulty } from "../BotConfig";
import { InputButtons } from "../BotConfig";
import { BotCoverPeek } from "../BotCoverPeek";
import type { BotGameState, Vec3, VisiblePlayer } from "../BotGameState";
import { vec3Subtract } from "../BotGameState";
import type { BotLife } from "../BotLife";
import type { BotMood } from "../BotMood";
import { PHYSICS } from "../BotMovementProfile";
import type { BotNavGraph } from "../BotNavGraph";
import type { BotVision, VisionResult } from "../BotVision";
import { BotWeaponCombos, has, slotFor } from "../BotWeaponCombos";
import { getWeaponProfile, selectBestWeapon, type WeaponProfile } from "../BotWeaponProfile";
import type { BotTraversal } from "../navigation/BotTraversal";
import { canLunge } from "../sequences/SlideBladeSequence";

/** How far off a wild shot goes, and how far an item may be to glance at. */
const WILD_SHOT_OFFSET = (5 * Math.PI) / 180;
const ITEM_GLANCE_RANGE = 1200;
const MELEE_RANGE = 150;
const CLOSE_RANGE = 400;
/** The slide's own cooldown plus its length, in server ticks, from the start of the last one. */
const SLIDE_COOLDOWN_TICKS = Math.ceil(((PHYSICS.SLIDE_COOLDOWN + PHYSICS.SLIDE_DURATION) / 1000) * TICK_RATE);
/** Too hurt to dive in with a blade. */
const LUNGE_MIN_HEALTH = 30;
/** A lunge chance passed up is not rolled for again this soon. */
const LUNGE_REROLL_TICKS = 125;
/** Cover is fought from at this range and further: closer, the fight is too quick for it. */
const COVER_MIN_RANGE = 350;
/** How often a bot with a splash weapon looks for a ledge to fight from. */
const HIGH_GROUND_SEARCH_TICKS = 250;
/** A heard enemy this close gets the gun for its distance readied, held this long. */
const READY_RANGE = 1500;
const READY_TICKS = 250;
/** Out of a fight, the gun put up in place of the blade is the best one at this range. */
const HOLSTER_RANGE = 800;
/** A charged blast is let go within this of the aim (radians)… */
const CHARGE_RELEASE_CONE = (12 * Math.PI) / 180;
/** …or this many ticks after its planned release, on the aim or not. */
const CHARGE_AIM_GRACE_TICKS = Math.round(0.5 * TICK_RATE);
/** A blade charge is held out of a fight at most this long after it started. */
const CHARGE_CARRY_TICKS = Math.round(2 * TICK_RATE);

/** Odds of taking a lunge chance, by dodgeSkill: never below 0.35 (Easy), 25% Medium, 60% Hard, 85% Insane. */
const LUNGE_CHANCE_POINTS: readonly (readonly [number, number])[] = [
  [0.35, 0],
  [0.4, 0.25],
  [0.7, 0.6],
  [0.9, 0.85],
];

export function lungeChance(dodgeSkill: number): number {
  const points = LUNGE_CHANCE_POINTS;
  if (dodgeSkill < points[0][0]) return 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (dodgeSkill <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (dodgeSkill - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/** What fighting needs of the brain. */
export interface FightHost {
  readonly life: BotLife;
  readonly navGraph: BotNavGraph | null;
  readonly vision: BotVision | null;
  readonly visionResult: VisionResult | null;
  readonly traversal: BotTraversal;
  readonly mood: BotMood;
  readonly difficulty: BotDifficulty;
  /** The difficulty aim plays at, after mood and a Duel lead. */
  readonly aimDifficulty: BotDifficulty;
  readonly currentState: BotState;
  /** Habits switched off for head-to-head tests. */
  readonly fightOff: ReadonlySet<string>;
  readonly bodyScale: number;
  /** The side the bot strafes to, 1 or -1. */
  strafeDirection: number;
  /** What the bot reckons an enemy carries. */
  enemyEstimate(entityId: string): { health: number; armor: number; uncertainty: number } | null;
  /** The HUNT state's input, for a fight with no one to fight. */
  hunt(state: BotGameState): BotInput;
}

export class BotFight {
  constructor(private readonly host: FightHost) {
    this.coverPeek = new BotCoverPeek(host.difficulty.dodgeSkill);
  }

  /** A new life: the fight's movement, cover peeks and combos start over. */
  startLife(): void {
    this.combatMovement.reset();
    this.coverPeek.reset();
    this.weaponCombos.reset();
  }

  lastSlideTick = Number.NEGATIVE_INFINITY;

  lungeRollAfterTick = 0;

  readonly combatMovement = new BotCombatMovement();

  readonly coverPeek: BotCoverPeek;

  /** When the bot last fired the weapon out, for peeking between shots. */
  firedTick = Number.NEGATIVE_INFINITY;

  readonly weaponCombos = new BotWeaponCombos();

  readyRollTick = 0;

  highGroundSearchTick = 0;

  fight(state: BotGameState): BotInput {
    // Find strongest enemy (from vision or fallback)
    const enemy = this.host.visionResult?.visibleEnemies[0]?.player ?? state.getNearestEnemy();
    if (!enemy) {
      return this.host.hunt(state);
    }

    const lunge = this.tryStartSlideBlade(state, enemy);
    if (lunge) return lunge;

    // Select best weapon for distance (profile-based). The server switches before
    // firing, so combat behavior can use the selected profile immediately.
    let { slot: weaponSlot, profile: selectedProfile } = selectBestWeapon(
      state.self.weapons,
      state.self.ammo,
      state.self.currentWeapon,
      enemy.distance,
    );
    let selectedWeaponId = weaponSlot > 0 ? state.self.weapons[weaponSlot - 1] : state.self.currentWeapon;
    let currentProfile = selectedProfile.id === "unknown" ? getWeaponProfile(selectedWeaponId) : selectedProfile;

    const mistake = this.host.mood.mistake(state.tick);
    if (mistake === "wrong_weapon" && state.self.currentWeapon) {
      // Fights on with whatever was out
      weaponSlot = 0;
      selectedWeaponId = state.self.currentWeapon;
      currentProfile = getWeaponProfile(selectedWeaponId);
    }

    // A combo (rocket into rail, riotgun or blade; a rail between plasma) overrides the distance pick
    const combo =
      mistake === "wrong_weapon"
        ? null
        : this.weaponCombos.choose(
            state,
            enemy,
            this.host.difficulty.predictionSkill,
            selectedWeaponId,
            this.host.enemyEstimate(enemy.entityId),
          );
    if (combo) {
      weaponSlot = slotFor(state, combo);
      selectedWeaponId = combo;
      currentProfile = getWeaponProfile(combo);
    }

    // Aim at enemy - use projectile prediction if needed.
    const useProjectileAim =
      (currentProfile.isProjectile || currentProfile.hasChargedProjectile) && currentProfile.projectileSpeed > 0;
    let aim = useProjectileAim ? this.aimWithLead(state, enemy, currentProfile) : this.aimAt(state, enemy);

    // Strafe while fighting: rhythm, dodges and hops from BotCombatMovement
    const moves = this.combatMovement.step(state, this.host.aimDifficulty, enemy.distance);
    let strafeInput = moves.strafe;
    // At range, from the edge of cover: out to shoot, back while reloading.
    const enemyInSight = this.host.visionResult
      ? this.host.visionResult.visibleEnemies.some((e) => e.player.playerId === enemy.playerId)
      : true;
    const peek = this.peekFromCover(state, enemy, currentProfile, selectedWeaponId, aim.yaw, enemyInSight);
    if (peek !== null && !this.combatMovement.dodging(state.tick)) strafeInput = peek;
    const peeking = peek !== null;
    if (strafeInput !== 0) this.host.strafeDirection = strafeInput;

    // Build buttons
    let buttons = 0;
    // Out of sight in cover there is nothing to shoot at, and a rocket into the wall hits the bot.
    let wantsFire = this.hasAmmoForWeapon(state, selectedWeaponId) && (enemyInSight || !peeking);

    if (mistake === "wild_shot") {
      // Fires before the aim is on: a few degrees off to one side
      const side = this.host.mood.mistakeTick % 2 === 0 ? 1 : -1;
      aim = { ...aim, yaw: aim.yaw + side * WILD_SHOT_OFFSET };
    } else if (mistake === "item_glance") {
      const item = state.getNearestPickup(ITEM_GLANCE_RANGE);
      if (item) {
        const dx = item.position.x - state.self.position.x;
        const dz = item.position.z - state.self.position.z;
        aim = { yaw: Math.atan2(dx, dz), pitch: 0 };
        wantsFire = false;
      }
    }

    // Weapon-aware combat behavior
    if (currentProfile.isMelee) {
      const chargeFire = this.updateChargedFire(state, enemy, selectedWeaponId, currentProfile, aim, wantsFire);

      if (chargeFire.holdAltFire) {
        buttons |= InputButtons.ALT_FIRE;
      }

      // Close range: swing. Mid range: keep pressure while charging/releasing the blade blast.
      if (enemy.distance < MELEE_RANGE && wantsFire && !chargeFire.holdAltFire) {
        buttons |= InputButtons.FIRE;
      }

      buttons |= InputButtons.FORWARD;
      buttons |= InputButtons.SPRINT;
    } else {
      this.clearChargedFire();

      // ADS whenever it tightens the shot; firing walks anyway, so aiming costs no speed.
      // A weapon whose aim takes time to settle holds fire until the server
      // counts the shot as aimed, which starts once that weapon is up.
      // Only with that weapon up: alt-fire pressed while the blade is still
      // out, mid-switch, starts a blade charge the switch then cancels.
      const aimsDownSights =
        currentProfile.aimsDownSights && wantsFire && state.self.currentWeapon === selectedWeaponId;
      if (aimsDownSights) buttons |= InputButtons.ALT_FIRE;
      if (!aimsDownSights || state.self.currentWeapon !== selectedWeaponId) this.host.life.adsSinceTick = null;
      else this.host.life.adsSinceTick ??= state.tick;
      const aimReady =
        currentProfile.adsReadyTicks === 0 ||
        (this.host.life.adsSinceTick !== null &&
          state.tick - this.host.life.adsSinceTick >= currentProfile.adsReadyTicks);

      // Fire
      if (wantsFire && aimReady) {
        buttons |= InputButtons.FIRE;
      }

      // Movement based on range
      if (enemy.distance > CLOSE_RANGE) {
        buttons |= InputButtons.FORWARD; // Close distance
      } else if (enemy.distance < MELEE_RANGE) {
        buttons |= InputButtons.BACK; // Too close for ranged, back up
      }

      // Back up from splash weapons at close range (avoid self-damage)
      if (currentProfile.hasSplash && enemy.distance < 250) {
        buttons |= InputButtons.BACK;
        buttons &= ~InputButtons.FORWARD;
      }
    }

    // Always sprint - arena FPS players strafe-run by default
    buttons |= InputButtons.SPRINT;

    if (strafeInput > 0) buttons |= InputButtons.RIGHT;
    else if (strafeInput < 0) buttons |= InputButtons.LEFT;
    if (moves.jump) buttons |= InputButtons.JUMP;
    if (moves.crouch) buttons |= InputButtons.CROUCH;

    if (wantsFire && (buttons & InputButtons.FIRE) !== 0 && state.self.currentWeapon === selectedWeaponId) {
      if (state.tick - this.firedTick >= currentProfile.fireIntervalTicks) this.firedTick = state.tick;
    }
    // Using cover, the bot keeps its distance: walking in leaves the cover behind.
    if (peeking) buttons &= ~(InputButtons.FORWARD | InputButtons.BACK);

    // Movement direction
    let forwardZ = 0;
    if (currentProfile.isMelee) {
      forwardZ = 1; // Always rush forward with melee
    } else if (enemy.distance > CLOSE_RANGE) {
      forwardZ = 1;
    } else if (enemy.distance < MELEE_RANGE || (currentProfile.hasSplash && enemy.distance < 250)) {
      forwardZ = -1;
    }
    if (peeking) forwardZ = 0;
    let strafeX = peeking ? strafeInput : strafeInput * 0.5;

    // With a splash weapon, take a ledge above the enemy when one is close
    const ledge = currentProfile.hasSplash && !peeking ? this.highGround(state, enemy) : null;
    if (ledge) {
      const towardYaw = Math.atan2(ledge.x - state.self.position.x, ledge.z - state.self.position.z);
      const off = towardYaw - aim.yaw;
      forwardZ = Math.cos(off);
      strafeX = Math.sin(off);
      buttons &= ~(InputButtons.FORWARD | InputButtons.BACK);
      buttons |= forwardZ >= 0 ? InputButtons.FORWARD : InputButtons.BACK;
    }

    return this.keepUpperGround(state, enemy, {
      direction: { x: strafeX, y: 0, z: forwardZ },
      pitch: aim.pitch,
      yaw: aim.yaw,
      buttons,
      weaponSlot,
    });
  }

  dodge(state: BotGameState): BotInput {
    // Sidestep threats; jump or slide only when the combat controller requests it.
    const enemyDistance = state.getNearestEnemy()?.distance ?? 0;
    const moves = this.combatMovement.step(state, this.host.aimDifficulty, enemyDistance);
    const side = moves.strafe;
    if (side !== 0) this.host.strafeDirection = side;

    let buttons = InputButtons.SPRINT;
    if (moves.jump) buttons |= InputButtons.JUMP;
    if (moves.crouch) buttons |= InputButtons.CROUCH;
    buttons |= this.host.strafeDirection > 0 ? InputButtons.RIGHT : InputButtons.LEFT;
    buttons |= InputButtons.FORWARD;

    // Try to aim at nearest visible enemy while dodging
    const enemy = this.host.visionResult?.visibleEnemies[0]?.player ?? state.getNearestEnemy();
    let pitch = state.self.pitch;
    let yaw = state.self.yaw;

    if (enemy) {
      const aim = this.aimAt(state, enemy);
      pitch = aim.pitch;
      yaw = aim.yaw;
      // Only fire if we have vision-confirmed LOS
      if (this.host.visionResult?.visibleEnemies.some((e) => e.player.playerId === enemy.playerId)) {
        buttons |= InputButtons.FIRE;
      }
    }

    return {
      direction: { x: this.host.strafeDirection, y: 0, z: 1 },
      pitch,
      yaw,
      buttons,
      weaponSlot: 0,
    };
  }

  /**
   * Maybe lunge at `enemy` with a crouch-slide and the blade. Each chance is
   * rolled once (then not again for a second), at odds from dodgeSkill: never
   * on Easy, most of the time on Insane. The slide's own cooldown is kept here,
   * from when this bot last stopped sliding.
   */
  tryStartSlideBlade(state: BotGameState, enemy: VisiblePlayer): BotInput | null {
    if (state.self.isSliding) this.lastSlideTick = state.tick;
    if (this.host.traversal.runtime.isActive || state.tick < this.lungeRollAfterTick) return null;
    if (state.tick - this.lastSlideTick < SLIDE_COOLDOWN_TICKS) return null;
    if (state.self.health < LUNGE_MIN_HEALTH) return null;
    const context = { ...this.host.traversal.context(state, null), combatTarget: enemy };
    if (!canLunge(context, enemy)) return null;
    this.lungeRollAfterTick = state.tick + LUNGE_REROLL_TICKS;
    if (Math.random() >= lungeChance(this.host.difficulty.dodgeSkill)) return null;
    if (!this.host.traversal.runtime.start("combat_slide_blade", context)) return null;
    return this.host.traversal.tick(state);
  }

  keepUpperGround(state: BotGameState, enemy: Pick<VisiblePlayer, "position">, input: BotInput): BotInput {
    const vision = this.host.vision;
    const self = state.self.position;
    if (
      !vision ||
      !state.self.isGrounded ||
      (this.host.fightOff.has("height") && !selectGametypeHabits(state.matchState.gametypeName).alwaysKeepsHeight) ||
      self.y - enemy.position.y < 64
    )
      return input;
    const heading = travelYaw(input) + Math.atan2(input.direction.x, input.direction.z);
    for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const yaw = heading + turn;
      const target = { x: self.x + Math.sin(yaw) * 96, y: self.y, z: self.z + Math.cos(yaw) * 96 };
      if (!vision.isWalkable(self, target)) continue;
      const floor = vision.collisionWorld.trace(target, { ...target, y: target.y - 64 });
      if (!floor.hit || floor.fraction >= 1) continue;
      if (turn === 0) return input;
      input.moveYaw = yaw;
      input.direction = { x: 0, y: 0, z: 1 };
      input.buttons &= ~(InputButtons.LEFT | InputButtons.RIGHT | InputButtons.BACK);
      input.buttons |= InputButtons.FORWARD | InputButtons.SPRINT;
      return input;
    }
    return input;
  }

  /**
   * The strafe that fights from cover at range (BotCoverPeek), or null to
   * fight in the open: close in, with the blade, or with the habit off.
   */
  peekFromCover(
    state: BotGameState,
    enemy: VisiblePlayer,
    profile: WeaponProfile,
    weaponId: string,
    yaw: number,
    inSight: boolean,
  ): -1 | 0 | 1 | null {
    const vision = this.host.vision;
    if (
      !vision ||
      this.host.fightOff.has("cover") ||
      profile.isMelee ||
      enemy.distance < COVER_MIN_RANGE ||
      !state.self.isGrounded ||
      state.self.currentWeapon !== weaponId
    ) {
      this.coverPeek.reset();
      return null;
    }
    const self = state.self.position;
    const enemyEye = { x: enemy.position.x, y: enemy.position.y + DEFAULT_VIEWHEIGHT, z: enemy.position.z };
    return this.coverPeek.step({
      tick: state.tick,
      self,
      yaw,
      hidden: (at) => !vision.canSee({ x: at.x, y: at.y + DEFAULT_VIEWHEIGHT, z: at.z }, enemyEye),
      walkable: (to) => vision.isWalkable(self, to),
      refireTicks: profile.fireIntervalTicks,
      firedTick: this.firedTick,
      visible: inSight,
    });
  }

  /**
   * A ledge to fight from, looked for every two seconds while the bot has a
   * splash weapon and is not yet above the enemy. Dropped once reached.
   */
  highGround(state: BotGameState, enemy: VisiblePlayer): Vec3 | null {
    const self = state.self.position;
    if (
      this.host.life.highGroundSpot &&
      Math.hypot(this.host.life.highGroundSpot.x - self.x, this.host.life.highGroundSpot.z - self.z) < 48
    ) {
      this.host.life.highGroundSpot = null;
    }
    if (state.tick >= this.highGroundSearchTick) {
      this.highGroundSearchTick = state.tick + HIGH_GROUND_SEARCH_TICKS;
      const vision = this.host.vision;
      this.host.life.highGroundSpot =
        vision && this.host.navGraph && enemy.distance <= 900 && Math.random() < this.host.difficulty.dodgeSkill
          ? findHighGround(this.host.navGraph.nodes, self, enemy.position, (from, to) => vision.canSee(from, to))
          : null;
    }
    return this.host.life.highGroundSpot;
  }

  /**
   * Out of a fight, with an enemy heard close but not seen, get out the gun for
   * the distance they were heard at, so it is ready when they come round the
   * corner. Rolled every two seconds at `predictionSkill` odds.
   */
  readyForHeard(state: BotGameState, input: BotInput): void {
    if (
      this.host.life.readyWeapon &&
      (state.tick >= this.host.life.readyWeapon.until || !has(state, this.host.life.readyWeapon.weapon))
    ) {
      this.host.life.readyWeapon = null;
    }
    const heard = state.heardEnemies.reduce<VisiblePlayer | null>(
      (near, enemy) => (!near || enemy.distance < near.distance ? enemy : near),
      null,
    );
    if (!this.host.life.readyWeapon && heard && heard.distance <= READY_RANGE && state.tick >= this.readyRollTick) {
      this.readyRollTick = state.tick + READY_TICKS;
      if (Math.random() < this.host.difficulty.predictionSkill) {
        const { slot } = selectBestWeapon(
          state.self.weapons,
          state.self.ammo,
          state.self.currentWeapon,
          heard.distance,
        );
        const weapon = slot > 0 ? state.self.weapons[slot - 1] : state.self.currentWeapon;
        if (weapon) this.host.life.readyWeapon = { weapon, until: state.tick + READY_TICKS };
      }
    }
    if (this.host.life.readyWeapon && (input.weaponSlot ?? 0) === 0)
      input.weaponSlot = slotFor(state, this.host.life.readyWeapon.weapon);
    // Out of a fight, the blade goes away for a gun: whoever comes round the
    // next corner is more likely at mid range than in reach of a swing.
    if (
      (input.weaponSlot ?? 0) === 0 &&
      state.self.currentWeapon === "blade" &&
      this.host.life.chargeStartTick === null &&
      !this.host.fightOff.has("holster")
    ) {
      const { slot } = selectBestWeapon(state.self.weapons, state.self.ammo, state.self.currentWeapon, HOLSTER_RANGE);
      const weapon = slot > 0 ? state.self.weapons[slot - 1] : undefined;
      if (weapon && weapon !== "blade") input.weaponSlot = slot;
    }
  }

  hasAmmoForWeapon(state: BotGameState, weaponId: string): boolean {
    if (!weaponId) return true;
    const ammo = state.self.ammo[weaponId];
    return ammo === undefined || ammo > 0;
  }

  updateChargedFire(
    state: BotGameState,
    enemy: VisiblePlayer,
    weaponId: string,
    profile: WeaponProfile,
    aim: { yaw: number; pitch: number },
    wantsFire: boolean,
  ): { holdAltFire: boolean } {
    if (!profile.hasChargedProjectile || !weaponId || enemy.distance < MELEE_RANGE) {
      this.clearChargedFire();
      return { holdAltFire: false };
    }

    // If we are switching to this weapon, let the server confirm the switch before
    // starting charge state. This keeps the cached 125Hz input loop from charging
    // an old weapon for one snapshot interval.
    if (state.self.currentWeapon && weaponId !== state.self.currentWeapon) {
      this.clearChargedFire();
      return { holdAltFire: false };
    }

    const targetChanged = this.host.life.chargeTargetId !== enemy.playerId;
    const weaponChanged = this.host.life.chargeWeaponId !== weaponId;
    if (
      targetChanged ||
      weaponChanged ||
      this.host.life.chargeStartTick === null ||
      this.host.life.chargeReleaseTick === null
    ) {
      // A charge starts only when the bot means to fire; once started it is
      // held through a moment's hesitation, because letting go before the
      // minimum cancels it on the server.
      if (!wantsFire) {
        this.clearChargedFire();
        return { holdAltFire: false };
      }
      this.host.life.chargeWeaponId = weaponId;
      this.host.life.chargeTargetId = enemy.playerId;
      this.host.life.chargeStartTick = state.tick;

      const chargeSpan = Math.max(0, profile.chargeMaxTicks - profile.chargeMinTicks);
      const skillHold = 0.35 + this.host.difficulty.predictionSkill * 0.4;
      const jitter = (Math.random() - 0.5) * 0.15;
      const holdTicks = Math.round(profile.chargeMinTicks + chargeSpan * Math.max(0, Math.min(1, skillHold + jitter)));
      this.host.life.chargeReleaseTick = state.tick + Math.max(profile.chargeMinTicks, holdTicks);
      return { holdAltFire: true };
    }

    // Release on the aim: a blast let go while the view is still turning
    // misses. The charge stops growing at its maximum, so waiting costs only
    // time, and after CHARGE_AIM_GRACE_TICKS it goes anyway.
    const off = Math.max(Math.abs(wrapAngle(aim.yaw - state.self.yaw)), Math.abs(aim.pitch - state.self.pitch));
    const onAim = off <= CHARGE_RELEASE_CONE;
    if (
      state.tick >= this.host.life.chargeReleaseTick &&
      (onAim || state.tick >= this.host.life.chargeReleaseTick + CHARGE_AIM_GRACE_TICKS)
    ) {
      this.clearChargedFire();
      return { holdAltFire: false };
    }

    return { holdAltFire: true };
  }

  /**
   * A blade charge outlives the fight decision that started it: the enemy
   * steps out of sight, or a hit sends the bot dodging, and a player keeps
   * holding to let go when they are back. Carried up to CHARGE_CARRY_TICKS
   * with the charging weapon still out; any decision that lets go of
   * alt-fire otherwise ends the charge, on the server and here.
   */
  carryCharge(state: BotGameState, input: BotInput): void {
    if ((input.buttons & InputButtons.ALT_FIRE) !== 0 || this.host.life.chargeStartTick === null) return;
    const carried =
      !state.self.isDead &&
      this.host.currentState !== BotState.FIGHT &&
      state.self.currentWeapon === this.host.life.chargeWeaponId &&
      !input.script &&
      (input.weaponSlot ?? 0) === 0 &&
      state.tick - this.host.life.chargeStartTick < CHARGE_CARRY_TICKS;
    if (carried) input.buttons |= InputButtons.ALT_FIRE;
    else this.clearChargedFire();
  }

  clearChargedFire(): void {
    this.host.life.chargeWeaponId = null;
    this.host.life.chargeTargetId = null;
    this.host.life.chargeStartTick = null;
    this.host.life.chargeReleaseTick = null;
  }

  aimAt(state: BotGameState, target: VisiblePlayer): { pitch: number; yaw: number } {
    let targetPos = { ...target.position };

    // Predict target position based on velocity (for projectile weapons)
    if (this.host.difficulty.predictionSkill > 0) {
      const prediction = this.predictTargetPosition(state, target);
      targetPos = prediction;
    }

    // Weapons fire from the eye, not the player origin. Aim at the enemy origin
    // from our fire origin so same-floor shots do not pass above the target.
    const delta = vec3Subtract(targetPos, this.fireOrigin(state));
    const horizontalDist = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
    const perfectYaw = horizontalDist > 0.01 ? Math.atan2(delta.x, delta.z) : state.self.yaw;
    const perfectPitch =
      horizontalDist > 0.01 ? -Math.atan2(delta.y, horizontalDist) : delta.y > 0 ? -Math.PI / 2 : Math.PI / 2;

    // Where to look, exactly: the client turns the view there at this
    // difficulty's speed and adds its wandering error (BotAimController).
    return { yaw: perfectYaw, pitch: perfectPitch };
  }

  predictTargetPosition(_state: BotGameState, target: VisiblePlayer): Vec3 {
    // Estimate projectile travel time
    const distance = target.distance;
    const estimatedProjectileSpeed = 1400; // rough average projectile speed
    const travelTime = distance / estimatedProjectileSpeed;

    // Apply prediction with skill factor
    const predFactor = this.host.difficulty.predictionSkill * travelTime;

    return {
      x: target.position.x + target.velocity.x * predFactor,
      y: target.position.y + target.velocity.y * predFactor,
      z: target.position.z + target.velocity.z * predFactor,
    };
  }

  /**
   * Aim at target with projectile lead prediction.
   * Uses the weapon's projectile speed to predict where the target will be.
   */
  aimWithLead(state: BotGameState, target: VisiblePlayer, profile: WeaponProfile): { pitch: number; yaw: number } {
    // Estimate travel time: distance / projectileSpeed
    const travelTime = target.distance / (profile.projectileSpeed || 2500);

    // Predicted position = current position + velocity * travelTime
    const predicted: Vec3 = {
      x: target.position.x + (target.velocity?.x ?? 0) * travelTime,
      y: target.position.y + (target.velocity?.y ?? 0) * travelTime,
      z: target.position.z + (target.velocity?.z ?? 0) * travelTime,
    };

    // Splash weapons: aim slightly lower (toward feet)
    if (profile.hasSplash) {
      predicted.y -= 20;
    }

    // Calculate angles from the actual weapon fire origin.
    const diff = vec3Subtract(predicted, this.fireOrigin(state));
    const dist2D = Math.sqrt(diff.x * diff.x + diff.z * diff.z);

    const yaw = Math.atan2(diff.x, diff.z);
    const pitch = -Math.atan2(diff.y, dist2D);

    // Turn speed and aim error are the client's (BotAimController), as in _aimAtTarget.
    return { yaw, pitch };
  }

  /** Where this bot's shots leave from: its eye, as the game server places it. */
  fireOrigin(state: BotGameState): Vec3 {
    return {
      x: state.self.position.x,
      y: state.self.position.y + scaledBodyHeight(DEFAULT_VIEWHEIGHT, this.host.bodyScale),
      z: state.self.position.z,
    };
  }
}
