/**
 * FPS Gametypes
 */
export { BaseGametype, type GameResult } from "./BaseGametype";
export { Deathmatch } from "./Deathmatch";
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
// Future:
// export { TeamDeathmatch } from './TeamDeathmatch';
// export { CaptureTheFlag } from './CaptureTheFlag';
// export { Duel } from './Duel';
// export { Race } from './Race';
// export { Instagib } from './Instagib';
// export { ClanArena } from './ClanArena';
