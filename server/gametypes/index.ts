/**
 * FPS Gametypes
 */
export { BaseGametype, type GameResult } from './BaseGametype';
export { Deathmatch } from './Deathmatch';
export { MatchState } from './MatchState';
export {
    type SpawnPointStrategy,
    RandomSpawnStrategy,
    FurthestSpawnStrategy,
    TeamSpawnStrategy,
    createSpawnStrategy,
} from './SpawnPointStrategy';
export { GametypeController } from './GametypeController';
// Future:
// export { TeamDeathmatch } from './TeamDeathmatch';
// export { CaptureTheFlag } from './CaptureTheFlag';
// export { Duel } from './Duel';
// export { Race } from './Race';
// export { Instagib } from './Instagib';
// export { ClanArena } from './ClanArena';
