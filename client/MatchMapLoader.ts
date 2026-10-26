/**
 * MatchMapLoader — what a network match does when the server names its map:
 * load the map, then set up client prediction (collision, trigger volumes,
 * teleports), the camera controllers, and the watch/auto-join start.
 *
 * Moved out of Game.initializeNetwork unchanged; Game supplies what it owns
 * through {@link MatchMapHost}. One loader per connection, so the guard
 * against a repeated Welcome is per connection too.
 */

import { logRejection } from "../../../engine/core/AsyncErrors";
import { devLog } from "../../../engine/core/DevLog";
import { createLoadingOperationId } from "../../../engine/core/LoadingEvents";
import { PackageStore } from "../../../engine/loader/pk3/PackageStore";
import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
import { getCollisionManager } from "../../../engine/physics/CollisionManager";
import type { FPSGameConfig } from "../Game";
import { createBSPCollisionWorld } from "../simulation/collision/BSPCollisionWorld";
import { preloadFPSAudio } from "./FPSAudio";
import { preloadFPSWeapons } from "./FPSWeaponPreloader";
import type { V2NetworkClient } from "./V2NetworkClient";

export interface MatchMapHost {
  shutdown(): void;
  showFailure?(message: string): void;
  setCollisionWorld(collision: CollisionWorld | null): void;
  startUnderwaterView(scene: import("@babylonjs/core/scene").Scene): void;
  preparePlayers?(scene: import("@babylonjs/core/scene").Scene, signal: AbortSignal): Promise<void>;
  /** Read at each use, as Game's own field was: a shutdown mid-load clears it. */
  v2Client(): V2NetworkClient | null;
  spectatorCycling(): { getAliveCount(): number } | null;
  nextSpectateTarget(): void;
  joinGame(): void;
}

export class MatchMapLoader {
  /** Welcome can arrive more than once; the map loads for the first only. */
  private started = false;
  private cancelled = false;
  private readonly controller = new AbortController();
  readonly operationId = createLoadingOperationId();
  private releaseHold: (() => void) | null = null;

  cancel(): void {
    this.cancelled = true;
    this.controller.abort(new Error("Match load cancelled"));
    this.releaseHold?.();
  }

  constructor(
    private readonly host: MatchMapHost,
    private readonly config: FPSGameConfig,
  ) {}

  async onServerInfo(serverInfo: { map: string }): Promise<void> {
    // Prevent duplicate map loading (Welcome can be received multiple times)
    if (this.started) {
      return;
    }
    this.started = true;

    devLog(`[Game] Server map: ${serverInfo.map}`);

    // Keep the loading screen down until the GAME is ready, not just the
    // map. Everything below — audio decode, collision world, trigger
    // volumes, viewmodel warmup — used to run with the curtain already up,
    // so the player watched the world finish assembling itself.
    //
    // Taken before the load so there is no window where the map can
    // complete first, and released in the `finally` below so a failure
    // cannot leave anyone staring at a loading screen.
    const { MapLoadingOverlay } = await import("../../../engine/ui/MapLoadingOverlay");
    this.controller.signal.throwIfAborted();
    if (this.cancelled) return;
    const hold = MapLoadingOverlay.acquire("fps:postload", this.operationId, () => {
      this.controller.abort(new Error("Required match preparation stopped making progress. Please retry."));
    });
    const releaseForeground = PackageStore.shared.foregroundScope();

    this.releaseHold = () => {
      releaseForeground();
      hold.release();
      MapLoadingOverlay.cancel(this.operationId);
    };

    // Load the server's map via console command
    try {
      const { loadClientMap } = await import("../../../engine/loader/map/ClientMapLoader");
      this.controller.signal.throwIfAborted();
      const audio = preloadFPSAudio(this.controller.signal);
      const audioResult = audio.then(
        () => null,
        (error: unknown) => ({ error }),
      );
      const result = await loadClientMap(serverInfo.map, {
        signal: this.controller.signal,
        operationId: this.operationId,
      });

      if (this.cancelled) return;

      // Check if map load failed
      if (typeof result === "string" && /failed|no scene available|camerasystem not available/i.test(result)) {
        console.error(`[Game] Map load failed, disconnecting...`);
        this.host.shutdown();
        this.host.showFailure?.(String(result));
        return;
      }

      // Decode the compact Warsow combat bank while the lobby/map loading
      // flow is still active, so the first accepted shot has no fetch/decode stall.
      const audioFailure = await audioResult;
      if (audioFailure) throw audioFailure.error;
      this.controller.signal.throwIfAborted();
      if (this.cancelled) return;
      const { CameraSystem } = await import("../../../engine/camera/CameraSystem");
      this.controller.signal.throwIfAborted();

      // === CRITICAL: Set up FPS controller AFTER map loads ===
      // This prevents the race condition where scene empty/map command overrides the controller
      try {
        // Set up BSP collision for client prediction
        // This is critical for movement responsiveness (avoids "flying through walls" in prediction)
        const cm = getCollisionManager();
        if (cm.isInitialized()) {
          const collisionWorld = createBSPCollisionWorld();
          if (collisionWorld) {
            this.host.setCollisionWorld(collisionWorld);

            // Underwater tint/fog for whatever camera is active. Started
            // per map load because the scene is rebuilt each time and the
            // previous view has to be disposed with it, or the next map
            // inherits fog it never asked for.
            import("../../../engine/camera/CameraSystem")
              .then(({ CameraSystem: cs }) => {
                if (this.controller.signal.aborted) return;
                const underwaterScene = cs.getInstance().getCamera()?.getScene();
                if (underwaterScene) {
                  this.host.startUnderwaterView(underwaterScene);
                  this.host.setCollisionWorld(collisionWorld);
                }
              })
              .catch(logRejection("MatchMapLoader"));
          } else {
            throw new Error("Required client collision world is unavailable");
          }

          // Trigger volumes (teleporters/jumppads) for client prediction —
          // the SAME shared TriggerTable extraction the server runs, so
          // pads and teleporters are predicted with zero reconciliation snap.
          const bsp = cm.getBsp();
          if (bsp && this.host.v2Client()) {
            const { extractTriggerVolumes } = await import("../../../shared/bsp/TriggerTable");
            this.controller.signal.throwIfAborted();
            this.host.v2Client()!.setTriggerVolumes(extractTriggerVolumes(bsp.entities, bsp.models));
            const { extractSpawnFacings } = await import("../../../shared/bsp/SpawnPointTable");
            this.controller.signal.throwIfAborted();
            this.host.v2Client()!.setSpawnFacings(extractSpawnFacings(bsp.entities));
            // Face the way the map's spawn point faces whenever the server places us there.
            this.host.v2Client()!.onSpawnFacing((yaw) => {
              if (this.controller.signal.aborted) return;
              const controller = CameraSystem.getInstance().getController("fps");
              if (controller && "faceSpawn" in controller) {
                (controller as import("../camera/FPSController").FPSController).faceSpawn(yaw);
              }
            });

            // Prewarm the generic teleport-ghost pool so the FIRST
            // teleport already has its afterimage.
            import("../../../engine/camera/CameraSystem")
              .then(({ CameraSystem: cs }) => {
                if (this.controller.signal.aborted) return;
                const scene = cs.getInstance().getCamera()?.getScene();
                if (scene) {
                  import("./TeleportEffect")
                    .then(({ TeleportEffect }) => {
                      if (this.controller.signal.aborted) return;
                      TeleportEffect.getInstance().prewarm(scene);
                    })
                    .catch(logRejection("MatchMapLoader"));
                }
              })
              .catch(logRejection("MatchMapLoader"));

            // Rotate the local camera to the exit yaw when our own
            // prediction teleports (fresh inputs only, not replays), and
            // play the generic VFX: your OWN afterimage at the entry
            // (turn around and you're standing there) + speed-line bursts.
            this.host.v2Client()!.onTeleport((exitYaw, from, to, entryYaw) => {
              import("../../../engine/camera/CameraSystem")
                .then(({ CameraSystem: cs }) => {
                  if (this.controller.signal.aborted) return;
                  const controller = cs.getInstance().getController("fps");
                  if (controller && "setViewYaw" in controller) {
                    (controller as import("../camera/FPSController").FPSController).setViewYaw(exitYaw);
                  }
                  const scene = cs.getInstance().getCamera()?.getScene();
                  if (scene) {
                    import("./TeleportEffect")
                      .then(({ TeleportEffect }) => {
                        if (this.controller.signal.aborted) return;
                        TeleportEffect.getInstance().localTeleported(scene, from, to, entryYaw, exitYaw);
                      })
                      .catch(logRejection("MatchMapLoader"));
                  }
                })
                .catch(logRejection("MatchMapLoader"));
            });
          }
        } else {
          throw new Error("Required client map collision is not initialized");
        }

        const { FPSController } = await import("../camera/FPSController");
        this.controller.signal.throwIfAborted();
        const { FreeflyController } = await import("../../../engine/camera/controllers/FreeflyController");
        this.controller.signal.throwIfAborted();
        const cameraSystem = CameraSystem.getInstance();

        // Register FPS controller (but don't activate — player starts as spectator)
        if (!cameraSystem.getController("fps")) {
          cameraSystem.registerController("fps", new FPSController());
        }

        // Register and activate freefly controller for spectator mode
        if (!cameraSystem.getController("freefly")) {
          cameraSystem.registerController("freefly", new FreeflyController());
        }
        // Start in freefly mode (spectator default)
        cameraSystem.setController("freefly");

        const camera = cameraSystem.getFreeCamera();
        if (camera) {
          await this.host.preparePlayers?.(camera.getScene(), this.controller.signal);
          this.controller.signal.throwIfAborted();
          try {
            await preloadFPSWeapons(camera.getScene(), camera, () => hold.pulse(), this.controller.signal);
          } catch (error) {
            if (this.cancelled) return;
            throw error;
          }
        } else {
          throw new Error("Required match camera is unavailable");
        }

        if (this.cancelled) return;

        // WATCH mode: start auto-chase polling AFTER map loads
        // (must be here, not earlier — otherwise the freefly reset above overwrites the spectator camera)
        if (this.config.watchOnly) {
          const autoChaseInterval = setInterval(() => {
            if (this.cancelled) {
              clearInterval(autoChaseInterval);
              return;
            }
            const spectatorCycling = this.host.spectatorCycling();
            if (spectatorCycling && spectatorCycling.getAliveCount() > 0) {
              clearInterval(autoChaseInterval);
              this.host.nextSpectateTarget();
            }
          }, 200);
          // Safety: stop polling after 30s
          setTimeout(() => clearInterval(autoChaseInterval), 30000);
        }

        // Auto-join if requested (lobby flow — skip spectator overlay)
        if (this.config.autoJoin) {
          devLog("[Game] Auto-joining game (lobby flow)");
          // Small delay to ensure everything is settled
          setTimeout(() => {
            if (!this.cancelled) this.host.joinGame();
          }, 200);
        }
      } catch (e) {
        throw e;
      }
    } catch (error) {
      if (this.cancelled) return;
      console.error(`[Game] Failed to load map ${serverInfo.map}:`, error);
      devLog(`[Game] Disconnecting due to map load error...`);
      this.host.shutdown();
      this.host.showFailure?.(`Could not prepare the match: ${String(error)}`);
    } finally {
      // Whatever happened above, the curtain has to come up.

      releaseForeground();
      this.releaseHold = null;
      hold.release();
    }
  }
}
