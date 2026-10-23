import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { CameraSystem } from "../../../../engine/camera/CameraSystem";
import { Command, type CommandDef } from "../../../../engine/console/Command";
import { devLog } from "../../../../engine/core/DevLog";
import { EntityManager } from "../../world/EntityManager"; // Safe import for types/static access

export default class SpawnPickupCommand extends Command {
  readonly definition: CommandDef = {
    name: "spawn_pickable_entity",
    description: "Spawn a pickable entity (weapon/ammo) in front of player",
    usage: "spawn_pickable_entity <entity_id>",
    developer: true,
  };

  async execute(args: string[]): Promise<string | undefined> {
    if (args.length === 0) {
      return "Usage: spawn_pickable_entity <entity_id>";
    }

    const entityId = args[0];

    // Get EntityManager lazily
    let entityManager: EntityManager;
    let cameraSystem: CameraSystem;
    try {
      const { EntityManager } = await import("../../world/EntityManager");
      const { CameraSystem } = await import("../../../../engine/camera/CameraSystem");
      entityManager = EntityManager.getInstance();
      cameraSystem = CameraSystem.getInstance();
    } catch {
      return "EntityManager/CameraSystem not available";
    }

    const camera = cameraSystem.getCamera();
    if (!camera) {
      return "No active camera";
    }

    // Calculate spawn position: 200 units in front of camera (HORIZONTAL direction only)
    const forward = camera.getDirection(Vector3.Forward());
    // Zero out vertical component to get horizontal direction
    const horizontalForward = new Vector3(forward.x, 0, forward.z).normalize();
    // Spawn at camera X/Z + offset, but at eye level (or slightly above to avoid floor clip)
    const spawnPos = camera.position.add(horizontalForward.scale(200));
    // Use camera Y directly (maybe +10 to be safe from floor clipping)
    spawnPos.y = camera.position.y + 10;

    devLog(`[SpawnPickup] Spawning at ${spawnPos} (will drop via gravity)`);

    const success = await entityManager.spawnEntityById(entityId, spawnPos, camera.getScene(), { gravity: true });

    if (success) {
      return `Spawned ${entityId} at ${spawnPos}`;
    } else {
      return `Failed to spawn ${entityId} (invalid ID?)`;
    }
  }

  override getCompletions(_input: string, args: string[]): string[] {
    if (args.length <= 1) {
      try {
        const ids = EntityManager.getInstance().getRegisteredIds();
        const prefix = args[0]?.toLowerCase() || "";
        return ids.filter((id) => id.toLowerCase().startsWith(prefix));
      } catch {
        return [];
      }
    }
    return [];
  }
}
