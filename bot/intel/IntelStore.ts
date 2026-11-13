/**
 * IntelStore — where bots' match reports accumulate: `<data-dir>/bot-intel.db`.
 *
 * A SQLite file of the bot service's own, beside the lobby's `players.db` but
 * separate from it, so nothing written here can touch accounts, results or
 * ratings, and the file can be deleted at any time. Written once per bot per
 * match, at the end, in one transaction; never read while bots play. Its use is
 * `bot:intel`, which distils it into the checked-in per-map baseline
 * (`config/bot-intel/<map>.json`, IntelBaseline.ts).
 *
 * Rows carry no names or keys: an opponent is "human" or "bot". Rows older
 * than RETENTION_DAYS are deleted whenever the store is opened.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Fight } from "../strategy/MatchRead";
import type { JudgedEpisode } from "../strategy/Strategist";

export const INTEL_FILE = "bot-intel.db";
const RETENTION_DAYS = 90;

/** What one bot hands in at the end of a match. */
export interface MatchReport {
  map: string;
  gametype: string;
  /** easy | medium | hard | insane | custom */
  preset: string;
  /** BotRatingIdentity behaviour fingerprint. */
  behavior: string;
  score: number;
  bestOther: number;
  deaths: number;
  /** People in the match besides bots. */
  people: number;
  fights: readonly (Fight & { against: "human" | "bot" })[];
  episodes: readonly JudgedEpisode[];
}

export class IntelStore {
  private readonly db: DatabaseSync;

  static open(dataDir: string): IntelStore {
    fs.mkdirSync(dataDir, { recursive: true });
    return new IntelStore(path.join(dataDir, INTEL_FILE));
  }

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        map TEXT NOT NULL,
        gametype TEXT NOT NULL,
        preset TEXT NOT NULL,
        behavior TEXT NOT NULL,
        score INTEGER NOT NULL,
        best_other INTEGER NOT NULL,
        deaths INTEGER NOT NULL,
        people INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fights (
        match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        cell TEXT NOT NULL,
        against TEXT NOT NULL,
        own_start INTEGER NOT NULL,
        enemy_start INTEGER NOT NULL,
        dealt INTEGER NOT NULL,
        taken INTEGER NOT NULL,
        saw_first INTEGER NOT NULL,
        result TEXT NOT NULL,
        seconds REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS episodes (
        match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        diagnosis TEXT NOT NULL,
        strategy TEXT NOT NULL,
        reward REAL NOT NULL,
        seconds REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS matches_map ON matches(map, gametype);
    `);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.purge(Date.now());
  }

  /** Drop matches older than RETENTION_DAYS, with their fights and episodes. */
  purge(now: number): void {
    const before = now - RETENTION_DAYS * 24 * 3600 * 1000;
    this.db.prepare("DELETE FROM matches WHERE at < ?").run(before);
  }

  /** One bot's report, in one transaction. */
  record(report: MatchReport, at = Date.now()): void {
    this.db.exec("BEGIN");
    try {
      const match = this.db
        .prepare(
          "INSERT INTO matches (at, map, gametype, preset, behavior, score, best_other, deaths, people) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          at,
          report.map,
          report.gametype,
          report.preset,
          report.behavior,
          report.score,
          report.bestOther,
          report.deaths,
          report.people,
        );
      const id = Number(match.lastInsertRowid);
      const fight = this.db.prepare(
        "INSERT INTO fights (match_id, cell, against, own_start, enemy_start, dealt, taken, saw_first, result, seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const f of report.fights) {
        if (f.result === "open") continue;
        fight.run(
          id,
          f.cell,
          f.against,
          Math.round(f.ownStackAtStart),
          Math.round(f.enemyStackAtStart),
          Math.round(f.dealt),
          Math.round(f.taken),
          f.sawFirst ? 1 : 0,
          f.result,
          (f.lastContactTick - f.startTick) / 125,
        );
      }
      const episode = this.db.prepare(
        "INSERT INTO episodes (match_id, diagnosis, strategy, reward, seconds) VALUES (?, ?, ?, ?, ?)",
      );
      for (const e of report.episodes) episode.run(id, e.diagnosis, e.strategy, e.reward, e.seconds);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Maps with reports, and how many. */
  maps(): { map: string; gametype: string; matches: number }[] {
    return this.db
      .prepare("SELECT map, gametype, COUNT(*) AS matches FROM matches GROUP BY map, gametype ORDER BY map, gametype")
      .all() as { map: string; gametype: string; matches: number }[];
  }

  /** Fights on a map, summed per cell and opponent kind. */
  fightsByCell(map: string, gametype: string): FightCellRow[] {
    return this.db
      .prepare(
        `SELECT f.cell AS cell, f.against AS against, COUNT(*) AS n,
                SUM(f.result = 'kill') AS kills, SUM(f.result = 'death') AS deaths,
                AVG(f.dealt) AS dealt, AVG(f.taken) AS taken
           FROM fights f JOIN matches m ON m.id = f.match_id
          WHERE m.map = ? AND m.gametype = ?
          GROUP BY f.cell, f.against ORDER BY n DESC`,
      )
      .all(map, gametype) as unknown as FightCellRow[];
  }

  /** Strategy payoffs on a map, per diagnosis and strategy. */
  payoffs(map: string, gametype: string): PayoffRow[] {
    return this.db
      .prepare(
        `SELECT e.diagnosis AS diagnosis, e.strategy AS strategy, COUNT(*) AS n, AVG(e.reward) AS mean
           FROM episodes e JOIN matches m ON m.id = e.match_id
          WHERE m.map = ? AND m.gametype = ?
          GROUP BY e.diagnosis, e.strategy ORDER BY e.diagnosis, e.strategy`,
      )
      .all(map, gametype) as unknown as PayoffRow[];
  }

  close(): void {
    this.db.close();
  }
}

export interface FightCellRow {
  cell: string;
  against: string;
  n: number;
  kills: number;
  deaths: number;
  dealt: number;
  taken: number;
}

export interface PayoffRow {
  diagnosis: string;
  strategy: string;
  n: number;
  mean: number;
}
