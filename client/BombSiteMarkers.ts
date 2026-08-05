/**
 * BombSiteMarkers — where the sites are, and what happens when one goes up.
 *
 * Two jobs that belong together because they read the same data:
 *
 *  - **Markers.** A floating A/B beacon above each site, drawn THROUGH walls.
 *    That is not a cheat: both teams know where the sites are, and a mode where
 *    finding them is the challenge would be a worse mode. The marker answers
 *    "which way is B" without a map screen.
 *
 *  - **The detonation.** The server sends the whole blast schedule at once, and
 *    this plays it out. Authored on maps that provide `target_explosion`
 *    groups, traced from the site on the ones that do not.
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { AudioManager } from "../../../engine/AudioManager";
import { getExplosionEffect, ROCKET_EXPLOSION } from "../../../engine/weapon/ExplosionEffect";
import { type BombExplosionEvent, MatchStateManager } from "./MatchStateManager";

/** Height above the site origin, matching Warsow's own indicator model. */
const MARKER_HEIGHT = 128;
const MARKER_SIZE = 44;
/** Idle motion, so a marker reads as an objective rather than as scenery. */
const BOB_AMPLITUDE = 6;
const BOB_RATE = 1.1;
const SPIN_RATE = 0.6;

/** Site blasts are bigger than a rocket — this is a bomb, and it should read. */
const BLAST_SCALE = 2.2;
/** How far the detonation is felt. Map-scale, not weapon-scale. */
const BLAST_SHAKE_RANGE = 2600;
/** Warsow uses the rocket's explosion for the bomb; there is no dedicated one. */
const BLAST_SOUND = "sounds/weapons/rocket_strong_explosion.ogg";
/** Seconds between blast sounds, so a long chain reads as blasts not mud. */
const BLAST_SOUND_MIN_GAP = 0.09;

interface Marker {
  root: TransformNode;
  baseY: number;
}

/** Stable per-round identity for a repeated explosion snapshot. */
export function bombExplosionSignature(round: number, explosion: BombExplosionEvent | null): string | null {
  if (!explosion || explosion.points.length === 0) return null;
  const points = explosion.points
    .map((point) => `${point.x},${point.y},${point.z},${point.radius},${point.delay}`)
    .join(";");
  return `${round}:${points}`;
}

export class BombSiteMarkers {
  private readonly scene: Scene;
  private markers = new Map<number, Marker>();
  private elapsed = 0;
  /** When the last blast sound played, so a chain does not stack into mud. */
  private lastBlastSound = Number.NEGATIVE_INFINITY;
  /** Blasts still waiting to fire, as absolute times in `elapsed` seconds. */
  private pending: Array<{ at: number; position: Vector3; radius: number }> = [];
  /** Explosions already played, so a repeated snapshot does not replay them. */
  private playedSignature: string | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
    getExplosionEffect().init(scene);
  }

  update(dt: number): void {
    this.elapsed += dt;
    const match = MatchStateManager.getInstance();

    this.syncMarkers(match.bomb?.sites ?? []);
    this.scheduleExplosion(match);
    this.firePending();
  }

  // ── Markers ────────────────────────────────────────────────────────

  /** Build a marker per site, once, and animate whatever exists. */
  private syncMarkers(sites: ReadonlyArray<{ id: number; label: string; x: number; y: number; z: number }>): void {
    for (const site of sites) {
      let marker = this.markers.get(site.id);
      if (!marker) {
        marker = this.createMarker(site.label, new Vector3(site.x, site.y + MARKER_HEIGHT, site.z));
        this.markers.set(site.id, marker);
      }
      marker.root.position.y = marker.baseY + Math.sin(this.elapsed * BOB_RATE + site.id) * BOB_AMPLITUDE;
      marker.root.rotation.y = this.elapsed * SPIN_RATE;
    }

    // A mode without sites should show none — switching maps or gametypes must
    // not leave a beacon floating in a deathmatch.
    if (sites.length === 0 && this.markers.size > 0) this.clearMarkers();
  }

  private createMarker(label: string, position: Vector3): Marker {
    const root = new TransformNode(`bombsite_${label}`, this.scene);
    root.position.copyFrom(position);

    // The letter, on a billboarded plane so it is legible from any angle.
    const texture = new DynamicTexture(`bombsite_tex_${label}`, { width: 128, height: 128 }, this.scene, true);
    texture.hasAlpha = true;
    // drawText centres and measures for us; Babylon's ICanvasRenderingContext
    // does not expose textAlign/textBaseline, so hand-positioning would mean
    // measuring the glyph ourselves for no gain.
    texture.drawText(label, null, 96, "bold 104px sans-serif", "#fff2c4", "transparent", true);

    const material = new StandardMaterial(`bombsite_mat_${label}`, this.scene);
    material.diffuseTexture = texture;
    material.opacityTexture = texture;
    material.emissiveColor = new Color3(1, 0.82, 0.35);
    material.disableLighting = true;
    // Through walls. Both teams know where the sites are; hiding the marker
    // behind geometry would only cost players their bearings.
    material.disableDepthWrite = true;
    material.zOffset = -100;

    const plate = CreatePlane(`bombsite_plate_${label}`, { size: MARKER_SIZE }, this.scene);
    plate.material = material;
    plate.parent = root;
    plate.billboardMode = 7; // BILLBOARDMODE_ALL
    plate.renderingGroupId = 2;
    plate.isPickable = false;

    // A ring under the letter, to place the beacon in space — a billboard
    // alone gives no sense of where it actually is.
    const ringMat = new StandardMaterial(`bombsite_ring_${label}`, this.scene);
    ringMat.emissiveColor = new Color3(0.9, 0.6, 0.15);
    ringMat.disableLighting = true;
    ringMat.alpha = 0.55;
    ringMat.disableDepthWrite = true;
    ringMat.zOffset = -100;

    const ring = CreateCylinder(`bombsite_ringmesh_${label}`, { diameter: MARKER_SIZE, height: 1.5 }, this.scene);
    ring.material = ringMat;
    ring.parent = root;
    ring.position.y = -MARKER_SIZE * 0.65;
    ring.renderingGroupId = 2;
    ring.isPickable = false;

    return { root, baseY: position.y };
  }

  private clearMarkers(): void {
    for (const marker of this.markers.values()) marker.root.dispose(false, true);
    this.markers.clear();
  }

  // ── Detonation ─────────────────────────────────────────────────────

  /**
   * Turn the server's schedule into pending blasts, exactly once.
   *
   * The snapshot repeats the explosion for about a second so a dropped packet
   * cannot swallow it, which means this has to recognise a repeat — hence the
   * signature rather than a "seen it" boolean.
   */
  private scheduleExplosion(match: MatchStateManager): void {
    const explosion = match.explosion;
    const signature = bombExplosionSignature(match.round, explosion);
    if (!explosion || signature === null) {
      // The server repeats one detonation for reliability, then removes it.
      // That gap arms the renderer for the next detonation — including round 1
      // of a continuous rematch, where the round number can repeat.
      this.playedSignature = null;
      return;
    }

    if (signature === this.playedSignature) return;
    this.playedSignature = signature;

    for (const point of explosion.points) {
      this.pending.push({
        at: this.elapsed + Math.max(0, point.delay),
        position: new Vector3(point.x, point.y, point.z),
        radius: point.radius,
      });
    }
  }

  private firePending(): void {
    if (this.pending.length === 0) return;

    const due = this.pending.filter((blast) => blast.at <= this.elapsed);
    if (due.length === 0) return;
    this.pending = this.pending.filter((blast) => blast.at > this.elapsed);

    for (const blast of due) {
      // The bang. `ExplosionEffect` is pure VFX — it has no audio at all, and
      // the rocket's sound comes from the projectile impact path, which a
      // scripted detonation never goes through. So the whole thing played
      // silently: the one moment in the mode that should be unmissable.
      //
      // Warsow uses the rocket explosion here and so do we. Positional, because
      // a site going up somewhere across the map should sound like it did.
      //
      // Throttled: a chain fires up to thirty points and several can land on the
      // same frame, which stacks into mud and drowns everything else. Spacing
      // them keeps it a sequence of blasts rather than one wall of noise.
      if (this.elapsed - this.lastBlastSound >= BLAST_SOUND_MIN_GAP) {
        this.lastBlastSound = this.elapsed;
        AudioManager.getInstance().playSfx3D(BLAST_SOUND, blast.position);
      }

      getExplosionEffect().spawn(blast.position, {
        ...ROCKET_EXPLOSION,
        scale: ROCKET_EXPLOSION.scale * BLAST_SCALE,
        splashRadius: blast.radius,
        // Every blast shaking the camera at full strength during a thirty-point
        // chain is nausea, not drama.
        shakeIntensity: 0.35,
        // But it has to REACH. The rocket preset stops at 540 units, and anyone
        // still alive to watch a site go up is further away than that by
        // definition — so the detonation landed in silence for exactly the
        // people it is staged for. Per-blast strength stays low; the range is
        // what makes it a map event rather than a local one.
        shakeMaxRange: BLAST_SHAKE_RANGE,
      });
    }
  }

  dispose(): void {
    this.clearMarkers();
    this.pending = [];
  }
}
