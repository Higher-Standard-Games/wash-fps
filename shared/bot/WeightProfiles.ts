/**
 * Bot behavioural weight profiles — per-gametype POLICY as plain data
 * (docs/research/BOT_WEIGHTS_AND_GOALS.md §4).
 *
 * Washoi owns these profiles in its shared game code. The bot service and game
 * server can use the same gametype policy without importing each other's
 * process-specific implementation.
 *
 * The bot owns the SKILL (the consideration functions that produce scores);
 * this file owns the POLICY (how much each of those scores counts). Neither is
 * `BotDifficulty`, which is CAPABILITY — how well the bot executes. Collapsing
 * policy into capability is what makes "hard" bots merely reckless (§4.4).
 *
 * No protocol change is needed to use these: `MatchStateSnapshot.gametypeName`
 * is already on the wire, so a bot selects its profile from data it already
 * receives.
 */

export interface BotWeightProfile {
  /** How much the bot values an item for its own use. */
  itemGreed: number;
  /**
   * How much it values an item simply for the enemy not having it.
   *
   * Split from `itemGreed` because a single knob over both attractors cancels
   * out: scaling every item candidate by the same factor leaves the ranking
   * among them identical, so the weight could only ever act as an on/off switch.
   * Separating them is what lets duel (contest everything) differ from
   * deathmatch (take what you need) with no code difference.
   */
  itemDenial: number;
  /**
   * Multiplier on what the major items are worth: the armors, Mega Health and
   * powerups. Duel is won by controlling them, so it raises this well above 1;
   * a mode played for frags lowers it, so a bot fights rather than shops.
   */
  majorItemBias: number;
  /**
   * Item timing, 0..1: how far ahead a bot heads for a taken major item to be
   * there when it comes back. 1 is a full lead window (Duel: lock the opponent
   * out), 0 is off — round modes restore items per round, and a mode played
   * for frags does not wait on a timer.
   */
  itemTiming: number;
  /** Advance and complete the gametype objective. Phase 4. */
  objectivePush: number;
  /** Stay within supporting distance of allies. Phase 4. */
  teamCohesion: number;
  /** Guard whoever holds the flag/bomb. Phase 4. */
  carrierProtect: number;
  /** Hold strong ground rather than roam. Phase 3+. */
  mapControl: number;
  /** Seek out and finish enemies. Phase 3+. */
  aggression: number;
  /**
   * How far the above push through danger. Higher = less suppression.
   * A modifier on the danger discount, not a goal of its own.
   */
  riskTolerance: number;
}

/**
 * Fallback for any gametype without an entry. Deathmatch-shaped, because an
 * unknown mode behaving like deathmatch is always safe — a missing profile must
 * never throw or produce a bot that stands still.
 */
export const DEFAULT_WEIGHT_PROFILE: BotWeightProfile = {
  itemGreed: 1.0,
  itemDenial: 0.3,
  majorItemBias: 1.0,
  itemTiming: 0,
  objectivePush: 0.0,
  teamCohesion: 0.0,
  carrierProtect: 0.0,
  mapControl: 0.3,
  aggression: 0.8,
  riskTolerance: 0.5,
};

/**
 * Profiles by normalized key. Adding a gametype is an entry here plus, from
 * Phase 4, a directive emitter — never a change to bot code.
 */
export const WEIGHT_PROFILES: Readonly<Record<string, BotWeightProfile>> = {
  // Amphi is played for frags: short rounds in a small arena, kits instead of
  // map weapons. Fight; pick up what is on the way.
  amphi: {
    ...DEFAULT_WEIGHT_PROFILE,
    itemGreed: 0.6,
    itemDenial: 0.1,
    majorItemBias: 0.5,
    aggression: 1.0,
    riskTolerance: 0.7,
  },

  // Selfish and item-hungry: take what you need, contest only the big prizes.
  deathmatch: {
    ...DEFAULT_WEIGHT_PROFILE,
    itemGreed: 1.0,
    itemDenial: 0.3,
    itemTiming: 0.5,
    aggression: 0.8,
    riskTolerance: 0.5,
  },

  // Slightly more cautious than FFA — dying feeds the other team's score.
  team_deathmatch: {
    ...DEFAULT_WEIGHT_PROFILE,
    itemGreed: 0.9,
    itemDenial: 0.4,
    itemTiming: 0.5,
    teamCohesion: 0.5,
    mapControl: 0.4,
    aggression: 0.7,
    riskTolerance: 0.4,
  },

  // ── Search & Destroy ─────────────────────────────────────────────
  //
  // Four profiles, because the mode asks for four different things and the
  // difference between them is the difference between a bot that plays S&D and
  // one that plays deathmatch on a bomb map.
  //
  // Items still matter — the map spawns them and there is one of each per round
  // — but never more than the objective, which is why itemGreed sits below the
  // deathmatch value everywhere here.

  // Attacking, pre-plant. Push, take ground, get the bomb planted. Risk is
  // acceptable: a round spent alive and unplanted is a round lost anyway.
  search_destroy: {
    ...DEFAULT_WEIGHT_PROFILE,
    itemGreed: 0.7,
    itemDenial: 0.2,
    majorItemBias: 0.7,
    objectivePush: 1.0,
    teamCohesion: 0.6,
    carrierProtect: 0.8,
    mapControl: 0.4,
    aggression: 0.7,
    riskTolerance: 0.6,
  },

  // Defending, pre-plant. The opposite disposition: hold, do not chase. A
  // defender who leaves their site to take a fight has given up the site, and
  // the attackers only need it undefended once.
  "search_destroy:defender": {
    ...DEFAULT_WEIGHT_PROFILE,
    itemGreed: 0.6,
    itemDenial: 0.2,
    majorItemBias: 0.7,
    objectivePush: 0.8,
    teamCohesion: 0.3,
    carrierProtect: 0.0,
    mapControl: 1.0,
    aggression: 0.4,
    riskTolerance: 0.3,
  },

  // Defending, post-plant. Everything inverts: the ground is worthless, only
  // the bomb matters, and there is no reason left to preserve yourself — the
  // round is lost in thirty seconds regardless. The most extreme profile in the
  // game, and correctly so.
  "search_destroy:defender:post_plant": {
    ...DEFAULT_WEIGHT_PROFILE,
    itemGreed: 0.1,
    itemDenial: 0.0,
    objectivePush: 1.0,
    teamCohesion: 0.2,
    carrierProtect: 0.0,
    mapControl: 0.1,
    aggression: 0.5,
    riskTolerance: 1.0,
  },

  // Attacking, post-plant. Also inverted, the other way: the job is done and
  // the only way to lose it is to be moved off the ground. Hold, do not chase,
  // and stop caring about items entirely.
  "search_destroy:attacker:post_plant": {
    ...DEFAULT_WEIGHT_PROFILE,
    itemGreed: 0.2,
    itemDenial: 0.0,
    objectivePush: 0.9,
    teamCohesion: 0.5,
    carrierProtect: 0.0,
    mapControl: 0.9,
    aggression: 0.4,
    riskTolerance: 0.35,
  },

  // Duel IS item control: the armors and Mega Health are the game, and locking
  // the opponent out of them wins it. They are worth far more than a third gun,
  // denial is nearly as strong as personal need, and the bot plays tighter,
  // because in a 1v1 a bad trade loses the round.
  duel: {
    ...DEFAULT_WEIGHT_PROFILE,
    itemGreed: 1.0,
    itemDenial: 0.9,
    majorItemBias: 1.8,
    itemTiming: 1.0,
    mapControl: 0.9,
    aggression: 0.5,
    riskTolerance: 0.3,
  },
};

/**
 * Normalize a gametype display name into a profile key.
 *
 * "Team Deathmatch" -> "team_deathmatch", "Search & Destroy" -> "search_destroy".
 * Dropped punctuation collapses rather than leaving a gap, so a display name is
 * free to contain an ampersand without the profile key growing a hole nobody
 * would guess at.
 */
export function weightProfileKey(gametypeName: string | undefined | null): string {
  if (!gametypeName) return "";
  return gametypeName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Select a profile for a gametype, optionally narrowed by role and round state
 * for modes where those change what the team wants (S&D defenders become
 * defusers after the plant).
 *
 * Resolution order, most specific first:
 *   gametype:role:roundState -> gametype:role -> gametype -> DEFAULT
 *
 * Never throws and never returns undefined; an unknown mode plays deathmatch.
 */
export function selectWeightProfile(
  gametypeName: string | undefined | null,
  role?: string | null,
  roundState?: string | null,
): BotWeightProfile {
  const base = weightProfileKey(gametypeName);
  if (!base) return DEFAULT_WEIGHT_PROFILE;

  const candidates: string[] = [];
  if (role && roundState) candidates.push(`${base}:${role}:${roundState}`);
  if (role) candidates.push(`${base}:${role}`);
  candidates.push(base);

  for (const key of candidates) {
    const profile = WEIGHT_PROFILES[key];
    if (profile) return profile;
  }
  return DEFAULT_WEIGHT_PROFILE;
}
