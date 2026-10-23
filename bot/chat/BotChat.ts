/**
 * BotChat — the odd line a bot says to the humans it plays with.
 *
 * - "gl hf" when the match goes live, "gg" in its last 30 seconds or when it ends.
 * - After killing a human: cheeky, a blade show-off, or a streak taunt.
 * - After a human kills it: gracious or mad by personality and mood, or a sulk
 *   when it keeps dying.
 *
 * Bots only talk about humans, and only when a human is in the match, so a
 * bot-only match (training, self-play) stays quiet. Each bot has a personality
 * from a hash of its name: how chatty it is and how sore a loser. A bot says at
 * most one line per 20 s, all bots in the process together at most one per 5 s,
 * and each line goes out 0.8–2.5 s after its moment, as if typed.
 */

import { isBotName } from "../../shared/bot/BotNames";
import type { Mood, MoodEvent } from "../BotMood";
import { BOT_CHAT_LINES, type ChatMoment } from "./BotChatLines";

const BOT_GAP_MS = 20_000;
const GLOBAL_GAP_MS = 5_000;
const TYPING_MIN_MS = 800;
const TYPING_MAX_MS = 2500;
/** "gg" once this little match time is left. */
const GG_SECONDS_LEFT = 30;
const PHASE_ACTIVE = 2;
const PHASE_POSTGAME = 3;

/** When any bot in this process last spoke; shared so a room of bots does not all talk at once. */
let lastAnyLineMs = Number.NEGATIVE_INFINITY;

/** For tests: forget when the last line was said. */
export function resetBotChatPacing(): void {
  lastAnyLineMs = Number.NEGATIVE_INFINITY;
}

export interface Personality {
  /** Chance to say something at a moment worth a line. */
  chatty: number;
  /** Chance a death by a human comes out mad rather than gracious. */
  sore: number;
}

/** A steady personality from the bot's name. */
export function personalityOf(name: string): Personality {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return { chatty: 0.25 + ((hash & 0xff) / 255) * 0.35, sore: 0.15 + (((hash >>> 8) & 0xff) / 255) * 0.5 };
}

export interface ChatView {
  /** MatchPhase. */
  phase: number;
  /** Seconds left in the match, when the server says. */
  timeRemaining?: number;
  /** Player name by entity id, everyone in the match. */
  names: ReadonlyMap<string, string>;
  mood: Mood;
  killStreak: number;
  deathStreak: number;
  events: readonly MoodEvent[];
}

export class BotChat {
  private readonly _personality: Personality;
  private _phase = -1;
  private _saidGg = false;
  private _lastLineMs = Number.NEGATIVE_INFINITY;
  private _pending: { text: string; atMs: number } | null = null;
  private readonly _recent: string[] = [];

  constructor(
    readonly name: string,
    private readonly _random: () => number = Math.random,
    private readonly _now: () => number = Date.now,
  ) {
    this._personality = personalityOf(name);
  }

  get personality(): Personality {
    return this._personality;
  }

  /** Looks at the match and decides whether to start typing something. */
  observe(view: ChatView): void {
    const humans = [...view.names.values()].filter((n) => !isBotName(n));
    const previousPhase = this._phase;
    this._phase = view.phase;
    if (view.phase !== PHASE_ACTIVE && view.phase !== PHASE_POSTGAME) this._saidGg = false;
    if (humans.length === 0) return;
    const anyHuman = humans[Math.floor(this._random() * humans.length) % humans.length];

    if (view.phase === PHASE_ACTIVE && previousPhase !== -1 && previousPhase < PHASE_ACTIVE) {
      this._maybe("greet", anyHuman, 0.5);
    }
    const nearEnd =
      (view.phase === PHASE_ACTIVE && view.timeRemaining !== undefined && view.timeRemaining <= GG_SECONDS_LEFT) ||
      (view.phase === PHASE_POSTGAME && previousPhase === PHASE_ACTIVE);
    if (nearEnd && !this._saidGg) {
      this._saidGg = true;
      this._maybe("gg", anyHuman, 0.7, true);
    }

    for (const event of view.events) {
      const other = view.names.get(event.otherEntityId);
      if (!other || isBotName(other)) continue;
      if (event.kind === "kill") {
        const moment: ChatMoment =
          event.weaponId === "blade" ? "bladeKill" : view.killStreak >= 3 ? "streak" : "killedHuman";
        this._maybe(moment, other);
      } else {
        const sore = view.mood === "tilted" ? 0.8 : this._personality.sore;
        const moment: ChatMoment =
          view.deathStreak >= 3 && this._random() < 0.5 ? "sulk" : this._random() < sore ? "mad" : "gracious";
        this._maybe(moment, other);
      }
    }
  }

  /** The line to send now, if one is done typing. */
  poll(): string | null {
    if (!this._pending || this._now() < this._pending.atMs) return null;
    const { text } = this._pending;
    this._pending = null;
    return text;
  }

  /**
   * Starts typing a line for `moment` at `chance` (the bot's chattiness by
   * default), if this bot and the room have been quiet long enough. `force`
   * replaces a line still being typed.
   */
  private _maybe(moment: ChatMoment, about: string, chance = this._personality.chatty, force = false): void {
    const now = this._now();
    if (this._pending && !force) return;
    if (now - this._lastLineMs < BOT_GAP_MS || now - lastAnyLineMs < GLOBAL_GAP_MS) return;
    if (this._random() >= chance) return;
    const text = this._pick(moment).split("{name}").join(about).slice(0, 128);
    const typing = TYPING_MIN_MS + this._random() * (TYPING_MAX_MS - TYPING_MIN_MS);
    this._pending = { text, atMs: now + typing };
    this._lastLineMs = now;
    lastAnyLineMs = now;
  }

  /** A line for `moment`, not one of this bot's last few. */
  private _pick(moment: ChatMoment): string {
    const lines = BOT_CHAT_LINES[moment];
    let line = lines[0];
    for (let attempt = 0; attempt < 4; attempt++) {
      line = lines[Math.floor(this._random() * lines.length) % lines.length];
      if (!this._recent.includes(line)) break;
    }
    this._recent.push(line);
    if (this._recent.length > 6) this._recent.shift();
    return line;
  }
}
