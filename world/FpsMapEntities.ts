import type { GameMapEntities } from "../../../engine/loader/map/GameMapEntities";
import { initializeEntityDefs } from "../shared/entities";
import { EntityManager } from "./EntityManager";

export const fpsMapEntities: GameMapEntities = {
  initializeDefinitions: initializeEntityDefs,
  registerHandlers: () => EntityManager.getInstance().registerHandlers(),
  disposeMapEntities: () => EntityManager.getInstance().disposeMapEntities(),
};
