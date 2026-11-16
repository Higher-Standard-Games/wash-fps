/**
 * One timer for every bot in the process: each bot's input loop runs from
 * it, at the server's tick rate, instead of a timer of its own per bot. A bot
 * still paces its commands by its own clock (BotClient._inputTick), so what it
 * sends does not change; ten bots cost one timer firing instead of ten.
 *
 * Decisions are spread over the snapshots too: `decisionPhase` gives each bot
 * a different turn when bots decide less often than every snapshot
 * (BotOptions.decideEvery).
 */

/** The server's tick, ms: 125 Hz. */
export const BOT_TICK_MS = 8;

type Tick = () => void;

const ticks = new Set<Tick>();
let timer: ReturnType<typeof setInterval> | null = null;
let nextPhase = 0;

/** Run `tick` every BOT_TICK_MS until the returned function is called. */
export function scheduleBotTick(tick: Tick): () => void {
  ticks.add(tick);
  timer ??= setInterval(() => {
    for (const run of ticks) run();
  }, BOT_TICK_MS);
  return () => {
    ticks.delete(tick);
    if (ticks.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Bots on the timer now. */
export function scheduledBotCount(): number {
  return ticks.size;
}

/** A turn for a new bot: bots deciding every n-th snapshot take turns n apart. */
export function decisionPhase(): number {
  return nextPhase++;
}
