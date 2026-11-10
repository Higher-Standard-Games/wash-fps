/**
 * How a free-for-all player looks to everyone: a body and a colour, handed out
 * by the server and sent in each player's snapshot record as one byte, the
 * model index in the high four bits and the colour index in the low four.
 * Every client and every demo then shows a player the same way.
 *
 * The orders below are the wire's: append, never reorder.
 */
export const LOOK_MODELS = ["police", "female", "cartel", "riotkitty", "robot"] as const;
export const LOOK_COLORS = ["pink", "cyan", "lime", "orange", "yellow", "red", "violet", "white"] as const;

export type LookModel = (typeof LOOK_MODELS)[number];
export type LookColor = (typeof LOOK_COLORS)[number];

export function encodeLook(model: number, color: number): number {
  return ((model & 0x0f) << 4) | (color & 0x0f);
}

/** The model and colour a look byte names, or null for an index this build does not know. */
export function decodeLook(look: number): { model: LookModel; color: LookColor } | null {
  const model = LOOK_MODELS[look >> 4];
  const color = LOOK_COLORS[look & 0x0f];
  return model && color ? { model, color } : null;
}

/**
 * The looks of a match's players. Each newcomer gets the least-worn colour and
 * the least-worn model, so up to eight players never share a colour and the
 * bodies spread evenly; a player keeps theirs while they stay in the match.
 */
export class PlayerLooks {
  private readonly looks = new Map<string, { model: number; color: number }>();

  constructor(private readonly random: () => number = Math.random) {}

  /** Bring the looks up to date with the players now in the match, and return each one's byte. */
  assign(players: Iterable<string>): Map<string, number> {
    const present = new Set(players);
    for (const id of this.looks.keys()) if (!present.has(id)) this.looks.delete(id);
    const bytes = new Map<string, number>();
    for (const id of present) {
      let look = this.looks.get(id);
      if (!look) {
        look = {
          model: this.leastWorn(LOOK_MODELS.length, "model"),
          color: this.leastWorn(LOOK_COLORS.length, "color"),
        };
        this.looks.set(id, look);
      }
      bytes.set(id, encodeLook(look.model, look.color));
    }
    return bytes;
  }

  clear(): void {
    this.looks.clear();
  }

  private leastWorn(count: number, part: "model" | "color"): number {
    const worn = new Array<number>(count).fill(0);
    for (const look of this.looks.values()) worn[look[part]]++;
    const fewest = Math.min(...worn);
    const pool = worn.flatMap((n, i) => (n === fewest ? [i] : []));
    return pool[Math.floor(this.random() * pool.length)];
  }
}
