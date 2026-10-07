/**
 * SpectateView — whose eyes the camera is behind when they are not our own,
 * and the cameras that put it there: the corpse-follow death camera, the
 * round-end intermission camera, and the first-person view of a living
 * teammate while dead in a round mode.
 *
 * Moved out of Game unchanged. Game reads the player's state through the host
 * and keeps its public names (applyDeathCamera, cycleTeammateSpectate) as
 * pass-throughs, so callers did not move.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CameraSystem } from "../../../engine/camera";
import type { GameState } from "../../../engine/network/core/GameState";
import { DEFAULT_VIEWHEIGHT } from "../../../engine/physics/PlayerPhysicsConstants";
import { getWeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import { clientKeyDisplayId } from "../ClientEntityKey";
import { DeathCamera } from "./DeathCamera";
import { FollowedViewWeapon } from "./FollowedViewWeapon";
import { MatchPhase, MatchStateManager } from "./MatchStateManager";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";
import { SpectateEyeCamera } from "./SpectateEyeCamera";
import type { SpectatorOverlay } from "./SpectatorOverlay";

/**
 * How long the death camera keeps your own corpse before handing over to a
 * teammate. Long enough for the ragdoll to land and be read as a death.
 */
export const SPECTATE_AFTER_DEATH_MS = 3000;

/** What the spectate cameras read from Game. Read live, every call. */
export interface SpectateHost {
  isPlayerDead(): boolean;
  playerState(): "spectator" | "playing";
  localPlayerId(): string;
  latestGameState(): GameState | null;
  remoteRenderer(): RemotePlayerRenderer | null;
  spectatorOverlay(): SpectatorOverlay | null;
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

    // Stamp the moment of death here rather than in the event handler: this
    // runs every frame and only needs the edge, so the death path stays
    // untouched by a camera concern.
    if (this.host.isPlayerDead() !== this._wasDeadLastFrame) {
      this._wasDeadLastFrame = this.host.isPlayerDead();
      if (this.host.isPlayerDead()) this._deathAtMs = performance.now();
    }

    // The intermission wins: once a round is decided, everyone watches the same
    // thing, whether they were alive for it or not.
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
    const seed = this.spectateEyeSample(entityId) ?? this.drawnAt(entityId);
    if (!seed) return false;

    this._spectatingEntityId = entityId;
    this.host.remoteRenderer()?.setHiddenEntity(entityId);
    this._eyeCamera.start(() => this.spectateEyeSample(entityId), seed);
    // Released only now the eye camera is primed and will claim every frame.
    this._deathCamera.stop();
    this.host.spectatorOverlay()?.setSpectatingTarget(this.spectateeName(entityId));
    this.host.spectatorOverlay()?.setMode("first-person");
    console.log(`[Game] Spectating teammate: ${entityId}`);
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
  private drawnAt(entityId: string): import("./SpectateEyeCamera").SpectateEyeSample | null {
    const drawn = this.host.remoteRenderer()?.getRenderedPlayers().get(entityId);
    if (!drawn) return null;
    const camera = CameraSystem.getInstance().getCamera() as { rotation?: { x: number; y: number } } | null;
    return {
      x: drawn.position.x,
      y: drawn.position.y,
      z: drawn.position.z,
      yaw: camera?.rotation?.y ?? 0,
      pitch: camera?.rotation?.x ?? 0,
    };
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
   * Where the watched player is and what they are looking at, this frame.
   *
   * Position and angles come from the SAME snapshot deliberately. Taking the
   * position from the renderer's interpolated copy and the angles from the
   * latest packet would put the head a frame ahead of the body — a small lead
   * that reads as the view sliding around independently of the player.
   */
  spectateEyeSample(entityId: string): import("./SpectateEyeCamera").SpectateEyeSample | null {
    const entity = this.host.latestGameState()?.entities.get(entityId);
    if (!entity) return null;
    const transform = entity.getComponent("transform") as
      | { position?: { x: number; y: number; z: number }; rotation?: { x: number; y: number } }
      | undefined;
    if (!transform?.position) return null;
    const movement = entity.getComponent("movementState") as { crouchViewOffset?: number } | undefined;
    // Their stride's sway, rebuilt the way the demo viewer rebuilds it.
    const pose = this._followedWeapon.presentation;
    const sway = pose?.entityId === entityId ? pose : null;
    return {
      x: transform.position.x,
      y: transform.position.y,
      z: transform.position.z,
      yaw: transform.rotation?.y ?? 0,
      pitch: transform.rotation?.x ?? 0,
      // Same sum the local FPS camera uses, so ducking under a rail looks the
      // same watched as it does played.
      eyeHeight: DEFAULT_VIEWHEIGHT + (movement?.crouchViewOffset ?? 0),
      bobRight: sway?.cameraBobRight,
      bobUp: sway?.cameraBobUp,
      pitchOffsetDegrees: sway?.cameraPitchDegrees,
      rollDegrees: sway?.cameraRollDegrees,
    };
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
}
