import type { GameplayMapLauncher, GameplayMapLaunchResult } from "../../../engine/console/GameplayMapLauncher";
import { Game } from "../Game";
import { ensureFpsLobbyConnection } from "./FpsLobbyService";

function normalizeGametype(input: string | undefined): string {
  const value = (input || "duel").trim().toLowerCase();
  switch (value) {
    case "1v1":
      return "duel";
    case "team":
    case "teamdeathmatch":
    case "team_deathmatch":
      return "tdm";
    case "dm":
    case "deathmatch":
      return "ffa";
    default:
      return value || "duel";
  }
}

export const fpsMapLauncher: GameplayMapLauncher = {
  async launch(mapName: string, gametype: string = "duel"): Promise<GameplayMapLaunchResult> {
    const map = mapName.trim().toLowerCase();
    const normalizedGametype = normalizeGametype(gametype);

    if (!map) {
      throw new Error("Map name is required");
    }

    const client = await ensureFpsLobbyConnection();
    const spawned = await client.spawnDevServer(map, normalizedGametype);

    await Game.getInstance().initializeNetwork(spawned.serverUrl, {
      autoJoin: true,
    });

    return spawned;
  },

  async unload(): Promise<void> {
    Game.getInstance().shutdown();
  },
};
