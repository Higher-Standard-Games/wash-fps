/**
 * FPS Gametypes
 */
export { Amphi } from "./Amphi";
export { BaseGametype, type GameResult } from "./BaseGametype";
export { Deathmatch } from "./Deathmatch";
export { Duel } from "./Duel";
export { GametypeController } from "./GametypeController";
export { MatchState } from "./MatchState";
export { SearchAndDestroy } from "./SearchAndDestroy";
export {
  createSpawnStrategy,
  FurthestSpawnStrategy,
  RandomSpawnStrategy,
  type SpawnPointStrategy,
  TeamSpawnStrategy,
} from "./SpawnPointStrategy";
export { TeamDeathmatch } from "./TeamDeathmatch";
// Future:
// export { CaptureTheFlag } from './CaptureTheFlag';
// export { Race } from './Race';
// export { ClanArena } from './ClanArena';
