/**
 * SpectateView — whose eyes the camera is behind when they are not our own,
 * and the cameras that put it there: the corpse-follow death camera, the
 * round-end intermission camera, the first-person view of a living teammate
 * while dead in a round mode, a true spectator's chase camera, and the watched
 * player's weapon in front of whichever of those is running.
 *
 * Moved out of Game unchanged. Game reads the player's state through the host
 * and keeps its public names (applyDeathCamera, cycleTeammateSpectate,
 * spectatePlayer, exitChaseCam, ...) as pass-throughs, so callers did not move.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CameraSystem } from "../../../engine/camera";
import type { SpectatorController } from "../../../engine/camera/controllers/SpectatorController";
import type { SpectatorCycling } from "../../../engine/camera/controllers/SpectatorCycling";
import type { FirstPersonPose } from "../../../engine/camera/FirstPersonPose";
import { background } from "../../../engine/core/AsyncErrors";
import type { GameState } from "../../../engine/network/core/GameState";
import { DEFAULT_VIEWHEIGHT } from "../../../engine/physics/PlayerPhysicsConstants";
import { getWeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import { clientKeyDisplayId } from "../ClientEntityKey";
import { DeathCamera } from "./DeathCamera";
import { watchedEyePose } from "./DemoPovState";
import { devLog } from "./DevLog";
import { FollowedViewWeapon } from "./FollowedViewWeapon";
import { handleSpectatedWeaponState } from "./GameEvents";
import { clearLocalPowerups } from "./LocalPowerupState";
import { MatchPhase, MatchStateManager } from "./MatchStateManager";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";
import type { PlayerWeaponStates } from "./SnapshotStateStore";
import { SpectateEyeCamera } from "./SpectateEyeCamera";
import type { SpectatorOverlay } from "./SpectatorOverlay";

/**
 * How long the death camera keeps your own corpse before handing over to a
 * teammate. Long enough for the ragdoll to land and be read as a death.
 */
export const SPECTATE_AFTER_DEATH_MS = 3000;

/**
 * How long a chase camera waits on a dead player in a mode with respawns.
 * Past the server's forced respawn, twice the respawn delay: six seconds in
 * Deathmatch, Duel and Team Deathmatch.
 */
const CHASE_RESPAWN_WAIT_MS = 8000;

/** What the spectate cameras read from Game. Read live, every call. */
export interface SpectateHost {
  isPlayerDead(): boolean;
  playerState(): "spectator" | "playing";
  localPlayerId(): string;
  latestGameState(): GameState | null;
  remoteRenderer(): RemotePlayerRenderer | null;
  spectatorOverlay(): SpectatorOverlay | null;
  spectatorCycling(): SpectatorCycling | null;
  spectatorController(): SpectatorController | null;
  enemyWeapons(): Map<string, string>;
  playerWeapons(): PlayerWeaponStates;
}

export class SpectateView {
  constructor(private readonly host: SpectateHost) {}

  /** Smoothed corpse-follow death camera. Driven by FPSController each frame. */
  readonly _deathCamera: DeathCamera = new DeathCamera();
  /** First-person view of a living teammate, while dead in a round mode. */
  private _eyeCamera: SpectateEyeCamera = new SpectateEyeCamera();
  /**
   * The watched player's weapon in front of the camera, through the live view
   * weapon. The same code the demo viewer drives its own instance with.
   */
  readonly _followedWeapon = new FollowedViewWeapon(() => getWeaponViewManager());

  /** True while the round-end camera owns the view, so we know what to stop. */
  private _roundEndCameraActive = false;
  /** Teammate currently being watched while dead, or null. */
  _spectatingEntityId: string | null = null;
  /** Fire/alt-fire held last tick, so cycling steps once per press. */
  _specCycleHeld = false;
  /** When the local player last died, for the spectate hand-off delay. */
  private _deathAtMs = 0;
  private _wasDeadLastFrame = false;
  /** When the chase target was first seen dead; 0 while they are alive. */
  private _chaseBodySince = 0;

  /**
   * Whose eyes the view is currently behind, or null when it is our own: the
   * teammate we watch while dead, or the player a spectator is chasing.
   *
   * Read by the event layer to decide who the HUD, the view weapon and the
   * first-person sounds describe. A watched player's health, ammo and weapon
   * all arrive in the same snapshot as ours — the server broadcasts
   * combat_state and weapon_state for every player — so this is a routing
   * question, not a networking one.
   */
  get spectatingEntityId(): string | null {
    if (this._spectatingEntityId) return this._spectatingEntityId;
    if (this.host.playerState() !== "spectator") return null;
    return this.host.spectatorController()?.getTargetEntityId() ?? null;
  }

  /**
   * Drive the corpse-follow death camera. Called by FPSController at the very end
   * of its update (after all its own camera writes). Returns true when the death
   * camera took over the camera, so the controller skips its fallback roll/drop
   * and the view-bob pass.
   */
  applyDeathCamera(
    camera: import("./DeathCamera").DeathCameraTarget & import("./SpectateEyeCamera").SpectateEyeTarget,
    dt: number,
  ): boolean {
    this.updateRoundEndCamera();
    // First person wins whenever we are watching a living teammate. The chase
    // cam is for the ragdoll and the round-end focus; pointing it at a player
    // who walks around puts their own model across the screen.
    if (this._eyeCamera.update(dt, camera)) return true;
    if (this._deathCamera.update(dt, camera)) return true;

    // Nothing has a picture for this frame. In a round mode that must still
    // count as a claim.
    //
    // Returning false is not "no opinion" — the FPS controller reads it as
    // permission to apply its forty-degree death tilt, an effect meant to last
    // the couple of seconds before a deathmatch respawn. A round mode has no
    // respawn: you are dead until the round turns over, which can be ninety
    // seconds of watching the map at forty degrees. Every gap qualifies — a
    // death with no ragdoll to follow, a spectate between snapshots, and a
    // round that ends on the clock rather than on the bomb, where there is no
    // focus point for the intermission camera to move to at all.
    // A selected target is stronger evidence than the round counter. It is the
    // same state that drives the SPECTATING banner, and bot entity snapshots
    // can arrive on a different frame from match metadata. Once a target
    // exists, that harmless metadata gap must never reveal the 0.7rad fallback
    // death roll underneath the spectator camera.
    if (this._spectatingEntityId || (this.host.isPlayerDead() && MatchStateManager.getInstance().round > 0)) {
      camera.rotation.z = 0;
      return true;
    }

    return false;
  }

  /**
   * Point the camera at what decided the round, for the intermission.
   *
   * Reuses the death camera rather than adding a second one: it already
   * smooths, keeps itself out of walls and follows a moving target, and the job
   * here is the same job — watch a fixed point from a sensible distance while
   * the player has no control. The server sends the focus, so everyone watches
   * the same thing.
   *
   * A player who is dead already has this camera on their corpse. Retargeting
   * it to the bomb is the right call anyway: the corpse is not the story.
   */
  private updateRoundEndCamera(): void {
    const match = MatchStateManager.getInstance();

    // Also stamped from syncFollowedSubject; here too so the death frame reads
    // this death's time whichever of the two runs first.
    this.trackDeathEdge();

    // The intermission wins for the dead. This runs only while dead (the FPS
    // controller calls applyDeathCamera then), so a living player stays where
    // they are and hears the blast, and sees it if they are near; a dead one
    // watches what decided the round (Tarmo, 2026-10-08).
    const focus = match.phase === MatchPhase.RoundEnd ? match.roundResult?.focus : undefined;
    if (focus) {
      if (this._roundEndCameraActive) return;
      this._roundEndCameraActive = true;
      this.stopTeammateSpectate();
      const target = new Vector3(focus.x, focus.y, focus.z);
      // Approach from behind wherever the player was looking, so the cut is a
      // pull-back rather than a jump to an unrelated angle.
      const camera = CameraSystem.getInstance().getCamera() as { rotation?: { y: number } } | null;
      this._deathCamera.start(() => target, target, camera?.rotation?.y ?? 0);
      return;
    }

    if (this._roundEndCameraActive) {
      this._roundEndCameraActive = false;
      this.stopTeammateSpectate();
      if (!this.host.isPlayerDead()) this._deathCamera.stop();
    }

    this.updateTeammateSpectate(match);
  }

  /**
   * Stamp the moment of death on the edge from alive to dead.
   *
   * Stamped outside the event handler, so the death path stays untouched by a
   * camera concern. It has to run while alive as well, which the death camera
   * alone does not: it is only driven while dead, so after the first respawn
   * the flag stayed "dead", the next death had no edge, and the hand-off to a
   * teammate fired at once, timed from the first death (S1).
   */
  private trackDeathEdge(): void {
    const dead = this.host.isPlayerDead();
    if (dead === this._wasDeadLastFrame) return;
    this._wasDeadLastFrame = dead;
    if (dead) this._deathAtMs = performance.now();
  }

  /**
   * Every frame, dead or alive (from syncFollowedSubject).
   *
   * Alive means watching no one through their eyes. The teammate view is
   * otherwise released only by a frame that is dead outside an Active round,
   * and snapshots processed in a batch (a tab coming back) can revive us
   * without one (S4). `_spectatingEntityId` is only ever the teammate view;
   * a true spectator's chase target is the spectator controller's.
   */
  private trackLifeState(): void {
    this.trackDeathEdge();
    if (!this.host.isPlayerDead() && this._spectatingEntityId) this.stopTeammateSpectate();
  }

  /**
   * While dead in a round mode, watch a living teammate.
   *
   * There is no respawn in Search & Destroy, so a dead player would otherwise
   * spend up to ninety seconds staring at their own corpse while the round they
   * still care about happens elsewhere. Only after the death camera has had
   * time to land, though — being yanked off your own death the instant it
   * happens reads as a bug, and the ragdoll is worth a moment.
   *
   * Sticks with one teammate until they die rather than re-picking the nearest
   * every frame, which would cut between players every time two of them crossed.
   */
  private updateTeammateSpectate(match: MatchStateManager): void {
    const spectating = this.host.isPlayerDead() && match.round > 0 && match.phase === MatchPhase.Active;
    if (!spectating) {
      this.stopTeammateSpectate();
      // Release on every frame we are alive and not spectating, NOT only on the
      // frame the target is dropped.
      //
      // Those are not the same moment. Leaving a round drops the target while
      // the player is still dead (the phase leaves Active before the freeze
      // revives them), so the release was gated behind a target that had
      // already been cleared, and the camera stayed bound to whichever bot it
      // was following — through the freeze, through the respawn, and into the
      // next round, with the player alive and unable to see themselves move.
      if (!this.host.isPlayerDead()) this._deathCamera.stop();
      return;
    }

    if (performance.now() - this._deathAtMs < SPECTATE_AFTER_DEATH_MS) return;

    const players = this.host.remoteRenderer()?.getRenderedPlayers();
    if (!players || players.size === 0) return;

    // Still following someone alive? Leave it be.
    if (this._spectatingEntityId) {
      const current = players.get(this._spectatingEntityId);
      if (current && !current.dead) return;
    }

    const myTeam = match.playerTeams?.[clientKeyDisplayId(this.host.localPlayerId())];
    if (!myTeam) return;

    let chosen: string | null = null;
    for (const [entityId, player] of players) {
      // Your own hitbox is still in the renderer, just hidden — spectating it
      // would put the camera back on the corpse you were meant to leave.
      if (entityId === this.host.localPlayerId()) continue;
      if (player.dead) continue;
      if (match.playerTeams?.[clientKeyDisplayId(entityId)] !== myTeam) continue;
      chosen = entityId;
      break;
    }
    // Everyone on your side is down; the round is about to end anyway, so stay
    // on the corpse rather than cutting to an enemy.
    if (!chosen || chosen === this._spectatingEntityId) return;

    this.watchTeammate(chosen);
  }

  /**
   * Put the camera behind one teammate's eyes.
   *
   * Hiding their model is not cosmetic — the camera sits INSIDE their head, so
   * left visible it is a skull filling the screen from the inside, which is
   * exactly what a first-person view of someone else looks like if you forget
   * this step. The demo viewer has always done it; the live path never did.
   */
  private watchTeammate(entityId: string): boolean {
    // Seeded from where they are right now — the same reading that chose them.
    // Refuse the handoff outright if there is nothing to seed with: a camera
    // that cannot produce a frame is not neutral, because the FPS controller
    // falls back to the forty-degree death tilt when nobody claims the view.
    const seed = this.eyePose(entityId) ?? this.drawnAt(entityId);
    if (!seed) return false;

    this._spectatingEntityId = entityId;
    this.host.remoteRenderer()?.setHiddenEntity(entityId);
    this._eyeCamera.start(() => this.eyePose(entityId), seed);
    // Released only now the eye camera is primed and will claim every frame.
    this._deathCamera.stop();
    this.host.spectatorOverlay()?.setSpectatingTarget(this.spectateeName(entityId));
    this.host.spectatorOverlay()?.setMode("first-person");
    devLog(`[Game] Spectating teammate: ${entityId}`);
    return true;
  }

  /**
   * Fallback seed: where the renderer is drawing them, without view angles.
   *
   * Used when the latest snapshot has no entity for someone the renderer is
   * still drawing — a gap of a frame or two around PVS edges. Their facing is
   * unknown, so the camera keeps ours and picks theirs up on the next snapshot
   * rather than snapping to an arbitrary direction.
   */
  private drawnAt(entityId: string): FirstPersonPose | null {
    const drawn = this.host.remoteRenderer()?.getRenderedPlayers().get(entityId);
    if (!drawn) return null;
    const camera = CameraSystem.getInstance().getCamera() as { rotation?: { x: number; y: number } } | null;
    return {
      x: drawn.position.x,
      y: drawn.position.y + DEFAULT_VIEWHEIGHT,
      z: drawn.position.z,
      yaw: camera?.rotation?.y ?? 0,
      pitch: camera?.rotation?.x ?? 0,
    };
  }

  /**
   * Forget the session: no one watched, no camera running, no death remembered.
   * Called when the connection ends, so the next one starts as a fresh player.
   */
  reset(): void {
    this.stopTeammateSpectate();
    this._deathCamera.stop();
    this._eyeCamera.stop();
    this._roundEndCameraActive = false;
    this._specCycleHeld = false;
    this._deathAtMs = 0;
    this._wasDeadLastFrame = false;
    this._chaseBodySince = 0;
    this._followedWeapon.follow(null);
  }

  /** Drop the teammate view: camera released, and their model visible again. */
  stopTeammateSpectate(): void {
    if (this._spectatingEntityId === null) return;
    this._spectatingEntityId = null;
    this._specCycleHeld = false;
    this._eyeCamera.stop();
    this.host.remoteRenderer()?.setHiddenEntity(null);
    // The viewmodel came up to show THEIR gun. If we are still dead — the round
    // ended, or everyone on our side is down — it has to go away again, or a
    // borrowed weapon floats over the round-end camera. A respawn re-shows it
    // through the normal path.
    if (this.host.isPlayerDead()) getWeaponViewManager().setVisible(false);
    // Back to whatever the overlay was doing before. A player who is alive
    // again wants no overlay at all; a true spectator gets their own mode set
    // by the chase-cam path.
    if (this.host.playerState() !== "spectator") this.host.spectatorOverlay()?.setMode("hidden");
  }

  /**
   * The watched player's view this frame: the sample they are drawn with, at
   * their eye height, with their screen's view effects — the pose the demo
   * viewer builds for a recording. Taking the body and the view from one
   * sample keeps the camera with the world around it, which is drawn on the
   * same interpolation clock.
   */
  eyePose(entityId: string): FirstPersonPose | null {
    const sample = this.host.remoteRenderer()?.getEntitySample(entityId);
    if (!sample) return null;
    const pov = this._followedWeapon.presentation;
    return watchedEyePose(sample, pov?.entityId === entityId ? pov : null);
  }

  /** Display name for whoever we are watching, for the HUD banner. */
  private spectateeName(entityId: string): string {
    const players = this.host.latestGameState()?.players;
    if (players) {
      for (const player of players.values()) {
        if (player.entityId === entityId) return player.name || entityId;
      }
    }
    return entityId.replace("player_", "Player ");
  }

  /**
   * Step to the next living teammate while dead.
   *
   * Being pinned to whoever the auto-pick landed on is most of what makes
   * spectating feel broken: the round moves to the other site and you are still
   * watching someone hold an angle at the one you died on.
   */
  cycleTeammateSpectate(direction: 1 | -1): void {
    if (!this._spectatingEntityId) return;
    const candidates = this.spectatableTeammates();
    if (candidates.length < 2) return;
    const at = candidates.indexOf(this._spectatingEntityId);
    const next = candidates[(at + direction + candidates.length) % candidates.length];
    if (next && next !== this._spectatingEntityId) this.watchTeammate(next);
  }

  /** Living teammates currently rendered, in a stable order for cycling. */
  private spectatableTeammates(): string[] {
    const players = this.host.remoteRenderer()?.getRenderedPlayers();
    if (!players) return [];
    const match = MatchStateManager.getInstance();
    const myTeam = match.playerTeams?.[clientKeyDisplayId(this.host.localPlayerId())];
    if (!myTeam) return [];

    const out: string[] = [];
    for (const [entityId, player] of players) {
      if (entityId === this.host.localPlayerId() || player.dead) continue;
      if (match.playerTeams?.[clientKeyDisplayId(entityId)] !== myTeam) continue;
      out.push(entityId);
    }
    // Sorted, so ← and → stay opposites instead of following map insertion.
    return out.sort();
  }

  /**
   * Chase-cam: start following a specific player entity.
   */
  spectatePlayer(entityId: string): void {
    const spectatorCycling = this.host.spectatorCycling();
    const spectatorController = this.host.spectatorController();
    if (!spectatorController || !spectatorCycling) return;
    spectatorCycling.setTarget(entityId);
    spectatorController.setSpectateTarget(entityId);
    this._chaseBodySince = 0;
    // The camera goes to their eyes, which is INSIDE their head — leaving the
    // model on fills the screen with the inside of a skull. The demo viewer has
    // hidden the followed player since it shipped; this path never did, which
    // is why live chase-cam looked like a rendering fault rather than a view.
    this.host.remoteRenderer()?.setHiddenEntity(entityId);
    this.host.spectatorOverlay()?.setMode("first-person");
    this.host.spectatorOverlay()?.setSpectatingTarget(spectatorCycling.getPlayerName(entityId));
    CameraSystem.getInstance().setController("spectator");
    devLog(`[Game] Now spectating player: ${entityId}`);
  }

  /**
   * Chase-cam: cycle to next alive player.
   */
  nextSpectateTarget(): void {
    const spectatorCycling = this.host.spectatorCycling();
    if (!spectatorCycling) return;
    const next = spectatorCycling.next();
    if (next) {
      this.spectatePlayer(next);
    }
  }

  /**
   * Chase-cam: cycle to previous alive player.
   */
  prevSpectateTarget(): void {
    const spectatorCycling = this.host.spectatorCycling();
    if (!spectatorCycling) return;
    const prev = spectatorCycling.prev();
    if (prev) {
      this.spectatePlayer(prev);
    }
  }

  /**
   * Exit chase-cam: return to freefly spectator mode.
   */
  exitChaseCam(): void {
    this.host.spectatorCycling()?.clearTarget();
    this.host.spectatorController()?.clearSpectateTarget();
    // Whoever we were riding becomes a normal player again.
    this.host.remoteRenderer()?.setHiddenEntity(null);
    this.host.spectatorOverlay()?.setMode("freefly");
    background(this.switchToFreeflyCamera(), "SpectateView");
    devLog("[Game] Returned to freefly spectator");
  }

  /**
   * Keep the chase camera on the cycling list's target.
   *
   * The list moves on by itself when its target leaves the match. A target
   * who dies is waited for, as their own screen waits: the view holds where
   * they fell, without their gun, and picks them up at their respawn. A round
   * mode keeps the dead down until the next round, so there the camera moves
   * on after the same pause the teammate view gives a death; elsewhere only
   * once the server's forced respawn has passed.
   */
  syncChaseTarget(): void {
    const cycling = this.host.spectatorCycling();
    const chasing = this.host.spectatorController()?.getTargetEntityId();
    if (!cycling || !chasing) return;

    let target = cycling.getTargetEntityId();
    if (target && !cycling.isAlive(target)) {
      const now = performance.now();
      const wait = MatchStateManager.getInstance().round > 0 ? SPECTATE_AFTER_DEATH_MS : CHASE_RESPAWN_WAIT_MS;
      if (this._chaseBodySince === 0) this._chaseBodySince = now;
      else if (now - this._chaseBodySince >= wait) target = cycling.next() ?? target;
    } else {
      this._chaseBodySince = 0;
    }

    if (!target) this.exitChaseCam();
    else if (target !== chasing) this.spectatePlayer(target);
  }

  /**
   * Switch the active camera to freefly controller (for spectator mode).
   */
  async switchToFreeflyCamera(): Promise<void> {
    try {
      const { CameraSystem } = await import("../../../engine/camera/CameraSystem");
      const { FreeflyController } = await import("../../../engine/camera/controllers/FreeflyController");
      const cameraSystem = CameraSystem.getInstance();

      let controller = cameraSystem.getController("freefly");
      if (!controller) {
        controller = new FreeflyController();
        cameraSystem.registerController("freefly", controller);
      }
      FreeflyController.setCollisionEnabled(false);
      controller.setEnabled(true);
      cameraSystem.setController("freefly");

      devLog("[Game] Switched to freefly camera");
    } catch (e) {
      console.warn("[Game] Could not switch to freefly camera:", e);
    }
  }

  /**
   * Point the view weapon at whoever the camera is behind.
   *
   * The subject changes when a teammate view starts or ends, when a spectator
   * picks or drops a chase target, and on joining. Powerup timers describe
   * the same player the HUD does, so they start over with each subject; the
   * server resends a running timer in every snapshot.
   */
  syncFollowedSubject(): void {
    this.trackLifeState();
    const subject = this.spectatingEntityId;
    if (subject === this._followedWeapon.followedEntityId) return;
    clearLocalPowerups();
    if (!subject) {
      this._followedWeapon.follow(null);
      // A spectator flying free has no gun in front of them. A player keeps
      // theirs: it is already up, or the respawn path brings it back.
      if (this.host.playerState() === "spectator") getWeaponViewManager().setVisible(false);
      return;
    }
    if (this.host.playerState() === "spectator") this.ensureViewWeapon();
    const dead = this.host.remoteRenderer()?.getRenderedPlayers().get(subject)?.dead ?? false;
    this._followedWeapon.follow(subject, dead);
    // Up at once, gun and ammo, from the last weapon_state we stored for them.
    // The server sends it again only when it changes, so waiting for the next
    // one would leave the previous target's ammo on the HUD.
    const state = this.host.playerWeapons().get(subject);
    if (state) {
      handleSpectatedWeaponState(state, this._followedWeapon);
    } else {
      const weapon = this.host.enemyWeapons().get(subject);
      if (weapon) this._followedWeapon.showWeapon(weapon);
    }
  }

  /** The watched player's stride, for their weapon's sway and the camera's. */
  updateFollowedMotion(): void {
    const entityId = this._followedWeapon.followedEntityId;
    if (!entityId) return;
    const sample = this.host.remoteRenderer()?.getEntitySample(entityId);
    if (!sample) return;
    this._followedWeapon.setAiming(sample.aiming ?? false);
    this._followedWeapon.updateMotion(sample, FollowedViewWeapon.liveClock(performance.now()));
  }

  /**
   * The view weapon is built on joining, so a spectator who never joined has
   * none. Build it on the shared camera the first time they ride someone's
   * eyes; joining later rebuilds it for their own gun.
   */
  private ensureViewWeapon(): void {
    const wvm = getWeaponViewManager();
    if (wvm.isReady) return;
    const camera = CameraSystem.getInstance().getFreeCamera();
    const scene = camera?.getScene();
    if (camera && scene) wvm.init(scene, camera);
  }
}
