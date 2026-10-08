/**
 * FrameEffects — the client effect systems Game ticks every frame: gibs,
 * ragdolls, floating damage numbers, the damage overlay and cartoon hit
 * sprites. Each is loaded on first use and initialised once a scene exists.
 *
 * Moved out of Game.renderRemotePlayers unchanged. The systems are shared with
 * the event handlers through Game's event context (gibSystem, pendingGibSpawns,
 * ragdollSystem, cartoonHit), so those stay public.
 */

import type { Scene } from "@babylonjs/core/scene";

export class FrameEffects {
  gibSystem: any = null;
  private gibSystemLoading = false; // true while import() is pending
  pendingGibSpawns: { x: number; y: number; z: number; vx: number; vy: number; vz: number }[] = [];
  private damageNumbers: any = null;
  private damageOverlay: any = null;
  ragdollSystem: any = null;
  private ragdollSystemLoading = false;
  cartoonHit: any = null;
  private cartoonHitLoading = false;

  /** @param scene the game scene, read when a system finishes loading. */
  constructor(private readonly scene: () => Scene | null | undefined) {}

  /**
   * Remove every ragdoll and gib, and gibs still waiting for the system to
   * load. They belong to the map and match they came from: left alone, they
   * expire, and a ragdoll explodes into gibs, in the next one.
   */
  clearWorld(): void {
    this.pendingGibSpawns = [];
    this.ragdollSystem?.disposeAll();
    this.gibSystem?.clear();
  }

  /** Gib physics; Game runs this before the S&D bomb, as before. */
  updateGibs(dtSec: number): void {
    // Update gib physics (gravity, bouncing, tumble, fade)
    if (!this.gibSystem && !this.gibSystemLoading) {
      // Eagerly init on first frame so it's ready for death events
      this.gibSystemLoading = true;
      import("./GibSystem")
        .then((m) => {
          const gibs = m.GibSystem.getInstance();
          const gameScene = this.scene();
          if (gameScene) {
            gibs.init(gameScene); // init() handles scene changes gracefully
          }
          if (gibs["scene"]) {
            this.gibSystem = gibs;
            console.log(`[GibSystem] Initialized, flushing ${this.pendingGibSpawns.length} pending spawns`);
            // Flush any gib spawns that queued while loading
            for (const pending of this.pendingGibSpawns) {
              gibs.spawn(pending.x, pending.y, pending.z, pending.vx, pending.vy, pending.vz);
            }
            this.pendingGibSpawns = [];
          } else {
            // Scene not ready yet — allow retry on next frame
            console.log(`[GibSystem] Scene not ready, will retry next frame`);
            this.gibSystemLoading = false;
          }
        })
        .catch((e) => {
          console.error("[GibSystem] Failed to load GibSystem module:", e);
          this.gibSystemLoading = false;
        });
    } else if (this.gibSystem) {
      this.gibSystem.update(dtSec);
    }
  }

  /** Ragdolls, damage numbers, damage overlay and cartoon hits, after the S&D bomb. */
  updateHitEffects(dtSec: number): void {
    // Update ragdoll physics (Havok-driven skeleton ragdolls)
    if (!this.ragdollSystem && !this.ragdollSystemLoading) {
      this.ragdollSystemLoading = true;
      import("./RagdollSystem")
        .then((m) => {
          const ragdolls = m.RagdollSystem.getInstance();
          const gameScene = this.scene();
          if (gameScene) {
            ragdolls.init(gameScene);
            // Wire gib explosion callback (Warsow-style ragdoll cleanup)
            if (this.gibSystem) {
              ragdolls.setGibCallback((x: number, y: number, z: number, vx: number, vy: number, vz: number) => {
                this.gibSystem?.spawn(x, y, z, vx, vy, vz);
              });
            }
            this.ragdollSystem = ragdolls;
            console.log("[RagdollSystem] Initialized");
          } else {
            console.log("[RagdollSystem] Scene not ready, will retry");
            this.ragdollSystemLoading = false;
          }
        })
        .catch((e) => {
          console.error("[RagdollSystem] Failed to load:", e);
          this.ragdollSystemLoading = false;
        });
    } else if (this.ragdollSystem) {
      this.ragdollSystem.update(dtSec);
    }

    // Update floating damage numbers (float upward, fade out)
    if (this.damageNumbers) {
      this.damageNumbers.update(dtSec);
    } else {
      import("./DamageNumbers").then((m) => {
        const dn = m.DamageNumbers.getInstance();
        if (dn["scene"]) this.damageNumbers = dn;
      });
    }

    // Update damage overlay (directional red triangles + vignette)
    if (this.damageOverlay) {
      this.damageOverlay.update(dtSec);
    } else {
      import("../../../engine/ui/hud/DamageOverlay").then((m) => {
        this.damageOverlay = m.DamageOverlay.getInstance();
      });
    }

    // Update cartoon hit effects (Warsow-style POW! sprites)
    if (!this.cartoonHit && !this.cartoonHitLoading) {
      this.cartoonHitLoading = true;
      import("./CartoonHitEffect")
        .then((m) => {
          const ch = m.CartoonHitEffect.getInstance();
          const gameScene = this.scene();
          if (gameScene) {
            ch.init(gameScene);
            this.cartoonHit = ch;
            console.log("[CartoonHitEffect] Initialized");
          } else {
            this.cartoonHitLoading = false;
          }
        })
        .catch((e) => {
          console.error("[CartoonHitEffect] Failed to load:", e);
          this.cartoonHitLoading = false;
        });
    } else if (this.cartoonHit) {
      this.cartoonHit.update(dtSec);
    }
  }
}
