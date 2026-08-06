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
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder";
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
/**
 * Ring revolutions per second. Slow enough to read as idle, not as an alarm.
 *
 * Only a tilted, hollow ring shows rotation at all: a billboard ignores it and
 * a rotationally symmetric shape has nothing to show.
 */
const SPIN_RATE = 0.9;

/** Tilt on the ring, so it never presents perfectly edge-on or flat. */
const RING_TILT = 0.42;
const RING_THICKNESS = 2.4;

/** The stem down toward the floor, anchoring the beacon to a place. */
const STEM_DIAMETER = 3.2;
const STEM_ALPHA = 0.22;

/** Texture resolution for the framed letter. */
const GLYPH_TEXTURE_SIZE = 256;

/**
 * Amber, and deliberately NOT a team colour.
 *
 * A site belongs to the round, not to a side: attackers are going to it and
 * defenders are holding it, and colouring it for either would tell half the
 * server the wrong thing. Amber also sits clear of the pink/cyan the player
 * models use, so a beacon is never mistaken at distance for a person.
 */
const MARKER_GOLD = new Color3(1, 0.74, 0.24);
const MARKER_GOLD_CSS = "#ffbd3d";
const GLYPH_CSS = "#fff4d6";
/** Backing behind the glyph, so it reads against a bright wall too. */
const GLYPH_BACKING_CSS = "rgba(24, 14, 2, 0.55)";

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
  /** The tilted ring — the only part whose rotation is actually visible. */
  ring: TransformNode;
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
      // The ring turns, not the root — the root carries the billboard, which
      // ignores rotation, and the stem, which should hang straight.
      marker.ring.rotation.y = this.elapsed * SPIN_RATE;
    }

    // A mode without sites should show none — switching maps or gametypes must
    // not leave a beacon floating in a deathmatch.
    if (sites.length === 0 && this.markers.size > 0) this.clearMarkers();
  }

  /**
   * A beacon, in three parts:
   *
   *  - a **framed glyph** — the letter as a badge rather than a loose character,
   *    legible against a bright wall as well as a dark one;
   *  - a **hollow ring** around it, tilted and turning, which is what makes the
   *    marker read as live rather than as scenery;
   *  - a **stem** dropping to the site origin. A billboard alone gives the
   *    direction of a site but not how far down it sits, and on a map with
   *    catwalks over the floor that is most of the question.
   */
  private createMarker(label: string, position: Vector3): Marker {
    const root = new TransformNode(`bombsite_${label}`, this.scene);
    root.position.copyFrom(position);

    const plate = CreatePlane(`bombsite_plate_${label}`, { size: MARKER_SIZE }, this.scene);
    plate.material = this.glyphMaterial(label);
    plate.parent = root;
    plate.billboardMode = 7; // BILLBOARDMODE_ALL
    plate.renderingGroupId = 2;
    plate.isPickable = false;

    // Its own node so it can spin without the billboard or the stem joining in.
    const ring = new TransformNode(`bombsite_ringnode_${label}`, this.scene);
    ring.parent = root;

    const glow = this.beaconMaterial(`bombsite_ring_${label}`, 0.75);
    const ringMesh = CreateTorus(
      `bombsite_ringmesh_${label}`,
      { diameter: MARKER_SIZE * 1.18, thickness: RING_THICKNESS, tessellation: 28 },
      this.scene,
    );
    ringMesh.material = glow;
    ringMesh.parent = ring;
    // Tilted so it is never a flat line from eye level nor a flat disc from
    // above — either extreme is where a ring stops looking like a ring.
    ringMesh.rotation.x = RING_TILT;
    ringMesh.renderingGroupId = 2;
    ringMesh.isPickable = false;

    // Length is exactly the height the marker is raised by, so the stem ends on
    // the site origin whatever height the map puts it at.
    const stem = CreateCylinder(
      `bombsite_stem_${label}`,
      { diameter: STEM_DIAMETER, height: MARKER_HEIGHT, tessellation: 8 },
      this.scene,
    );
    stem.material = this.beaconMaterial(`bombsite_stem_mat_${label}`, STEM_ALPHA);
    stem.parent = root;
    stem.position.y = -MARKER_HEIGHT / 2;
    stem.renderingGroupId = 2;
    stem.isPickable = false;

    return { root, baseY: position.y, ring };
  }

  /** Emissive, unlit, drawn through walls — shared by the ring and the stem. */
  private beaconMaterial(name: string, alpha: number): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.emissiveColor = MARKER_GOLD;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    material.alpha = alpha;
    // Through walls. Both teams know where the sites are; hiding the marker
    // behind geometry would only cost players their bearings.
    material.disableDepthWrite = true;
    material.zOffset = -100;
    return material;
  }

  /** The letter, framed in a hexagon, as one texture. */
  private glyphMaterial(label: string): StandardMaterial {
    const size = GLYPH_TEXTURE_SIZE;
    const texture = new DynamicTexture(`bombsite_tex_${label}`, { width: size, height: size }, this.scene, true);
    texture.hasAlpha = true;

    const ctx = texture.getContext();
    const centre = size / 2;
    const radius = size * 0.43;

    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      // Pointy-top, so the shape is symmetric about the vertical axis and
      // survives drawText's Y inversion below without looking flipped.
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const x = centre + Math.cos(angle) * radius;
      const y = centre + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = GLYPH_BACKING_CSS;
    ctx.fill();
    ctx.lineWidth = size * 0.035;
    ctx.lineJoin = "round";
    ctx.strokeStyle = MARKER_GOLD_CSS;
    ctx.stroke();

    // drawText centres and measures for us; Babylon's ICanvasRenderingContext
    // does not expose textAlign/textBaseline, so hand-positioning would mean
    // measuring the glyph ourselves for no gain. A null clear colour keeps the
    // frame that was just drawn underneath it.
    texture.drawText(label, null, size * 0.68, `bold ${Math.round(size * 0.5)}px sans-serif`, GLYPH_CSS, null, true);

    const material = new StandardMaterial(`bombsite_mat_${label}`, this.scene);
    material.diffuseTexture = texture;
    material.opacityTexture = texture;
    material.emissiveColor = Color3.White();
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    material.disableDepthWrite = true;
    material.zOffset = -100;
    return material;
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
