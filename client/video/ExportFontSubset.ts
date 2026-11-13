/**
 * A TrueType font with only some glyph outlines, for a picture that shows a
 * known set of characters. Glyph IDs stay as they are, so the character map,
 * kerning, substitutions and metrics remain valid; every other glyph keeps
 * its slot with an empty outline. An SVG image re-reads its fonts on every
 * decode, so a movie's HUD carries these instead of whole scripts it never
 * draws.
 */

interface Table {
  tag: string;
  offset: number;
  length: number;
}

const TRUETYPE = 0x00010000;
const COMPONENT_WORDS = 0x0001;
const COMPONENT_SCALE = 0x0008;
const COMPONENT_MORE = 0x0020;
const COMPONENT_XY_SCALE = 0x0040;
const COMPONENT_2X2 = 0x0080;

function tables(view: DataView): Map<string, Table> {
  const found = new Map<string, Table>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(at),
      view.getUint8(at + 1),
      view.getUint8(at + 2),
      view.getUint8(at + 3),
    );
    found.set(tag, { tag, offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return found;
}

/** Glyph IDs of these code points, from a Windows Unicode character map (format 4 or 12). */
export function glyphsFor(font: ArrayBuffer, codePoints: Iterable<number>): Map<number, number> {
  const view = new DataView(font);
  const cmap = tables(view).get("cmap");
  if (!cmap) throw new Error("The font has no character map");
  let format4 = -1;
  let format12 = -1;
  const subtables = view.getUint16(cmap.offset + 2);
  for (let i = 0; i < subtables; i++) {
    const at = cmap.offset + 4 + i * 8;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const offset = cmap.offset + view.getUint32(at + 4);
    const format = view.getUint16(offset);
    if (format === 12 && (platform === 3 || platform === 0)) format12 = offset;
    if (format === 4 && ((platform === 3 && encoding === 1) || platform === 0)) format4 = offset;
  }
  const result = new Map<number, number>();
  for (const code of codePoints) {
    let glyph = 0;
    if (format12 >= 0) {
      const groups = view.getUint32(format12 + 12);
      for (let g = 0; g < groups; g++) {
        const at = format12 + 16 + g * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        if (code >= start && code <= end) {
          glyph = view.getUint32(at + 8) + (code - start);
          break;
        }
      }
    } else if (format4 >= 0 && code <= 0xffff) {
      const segments = view.getUint16(format4 + 6) / 2;
      const ends = format4 + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const ranges = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        if (code > view.getUint16(ends + s * 2)) continue;
        const start = view.getUint16(starts + s * 2);
        if (code < start) break;
        const delta = view.getInt16(deltas + s * 2);
        const range = view.getUint16(ranges + s * 2);
        if (range === 0) glyph = (code + delta) & 0xffff;
        else {
          const at = ranges + s * 2 + range + (code - start) * 2;
          const raw = view.getUint16(at);
          glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
        }
        break;
      }
    }
    if (glyph) result.set(code, glyph);
  }
  return result;
}

/** The glyphs a coverage table lists, in coverage order. */
function coverage(view: DataView, at: number): number[] {
  const glyphs: number[] = [];
  const format = view.getUint16(at);
  const count = view.getUint16(at + 2);
  if (format === 1) for (let i = 0; i < count; i++) glyphs.push(view.getUint16(at + 4 + i * 2));
  else if (format === 2) {
    for (let i = 0; i < count; i++) {
      const range = at + 4 + i * 6;
      for (let g = view.getUint16(range); g <= view.getUint16(range + 2); g++) glyphs.push(g);
    }
  }
  return glyphs;
}

/**
 * Add every glyph a substitution can turn kept glyphs into: tabular figures,
 * alternates, ligatures of kept letters. All lookups count, whatever feature
 * or script uses them, so the result covers whatever the text asks for.
 */
function substitutionClosure(view: DataView, gsub: Table | undefined, keep: Set<number>): void {
  if (!gsub) return;
  const lookups = gsub.offset + view.getUint16(gsub.offset + 8);
  const lookupCount = view.getUint16(lookups);
  const subtables: Array<[number, number]> = [];
  for (let l = 0; l < lookupCount; l++) {
    const lookup = lookups + view.getUint16(lookups + 2 + l * 2);
    const type = view.getUint16(lookup);
    const count = view.getUint16(lookup + 4);
    for (let s = 0; s < count; s++) {
      const at = lookup + view.getUint16(lookup + 6 + s * 2);
      const [kind, table] = type === 7 ? [view.getUint16(at + 2), at + view.getUint32(at + 4)] : [type, at];
      // Contextual lookups only point at others, which are read in their own right
      if (kind >= 1 && kind <= 4) subtables.push([kind, table]);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    const add = (glyph: number) => {
      if (!keep.has(glyph)) {
        keep.add(glyph);
        changed = true;
      }
    };
    for (const [type, at] of subtables) {
      const covered = coverage(view, at + view.getUint16(at + 2));
      const format = view.getUint16(at);
      covered.forEach((glyph, index) => {
        if (!keep.has(glyph)) return;
        if (type === 1) {
          if (format === 1) add((glyph + view.getInt16(at + 4)) & 0xffff);
          else add(view.getUint16(at + 6 + index * 2));
        } else if (type === 2 || type === 3) {
          const list = at + view.getUint16(at + 6 + index * 2);
          for (let i = 0; i < view.getUint16(list); i++) add(view.getUint16(list + 2 + i * 2));
        } else if (type === 4) {
          const set = at + view.getUint16(at + 6 + index * 2);
          for (let i = 0; i < view.getUint16(set); i++) {
            const ligature = set + view.getUint16(set + 2 + i * 2);
            const parts = view.getUint16(ligature + 2);
            let all = true;
            for (let p = 1; p < parts; p++) if (!keep.has(view.getUint16(ligature + 2 + p * 2))) all = false;
            if (all) add(view.getUint16(ligature));
          }
        }
      });
    }
  }
}

/**
 * The font with outlines only for the glyphs of `codePoints`, what they
 * substitute to and the parts they are built from, or null when it is not a
 * TrueType-outline font.
 */
export function subsetTrueType(font: ArrayBuffer, codePoints: Iterable<number>): ArrayBuffer | null {
  const view = new DataView(font);
  if (view.getUint32(0) !== TRUETYPE) return null;
  const found = tables(view);
  const head = found.get("head");
  const maxp = found.get("maxp");
  const loca = found.get("loca");
  const glyf = found.get("glyf");
  if (!head || !maxp || !loca || !glyf) return null;
  const glyphCount = view.getUint16(maxp.offset + 4);
  const longOffsets = view.getInt16(head.offset + 50) === 1;
  const offsetOf = (glyph: number) =>
    longOffsets ? view.getUint32(loca.offset + glyph * 4) : view.getUint16(loca.offset + glyph * 2) * 2;
  const keep = new Set<number>([0]);
  for (const glyph of glyphsFor(font, codePoints).values()) keep.add(glyph);
  substitutionClosure(view, found.get("GSUB"), keep);
  // Composite glyphs are drawn from others: keep those too
  const pending = [...keep];
  while (pending.length) {
    const glyph = pending.pop()!;
    if (glyph >= glyphCount) continue;
    const start = glyf.offset + offsetOf(glyph);
    if (offsetOf(glyph + 1) - offsetOf(glyph) < 10 || view.getInt16(start) >= 0) continue;
    let at = start + 10;
    for (;;) {
      const flags = view.getUint16(at);
      const component = view.getUint16(at + 2);
      if (!keep.has(component)) {
        keep.add(component);
        pending.push(component);
      }
      at += 4 + (flags & COMPONENT_WORDS ? 4 : 2);
      if (flags & COMPONENT_SCALE) at += 2;
      else if (flags & COMPONENT_XY_SCALE) at += 4;
      else if (flags & COMPONENT_2X2) at += 8;
      if (!(flags & COMPONENT_MORE)) break;
    }
  }
  // The kept outlines, each on a two-byte boundary, as short offsets allow
  const parts: Array<[number, number]> = [];
  const offsets = new Uint32Array(glyphCount + 1);
  let size = 0;
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    offsets[glyph] = size;
    if (!keep.has(glyph)) continue;
    const from = offsetOf(glyph);
    const length = offsetOf(glyph + 1) - from;
    if (length <= 0) continue;
    parts.push([glyf.offset + from, length]);
    size += (length + 1) & ~1;
  }
  offsets[glyphCount] = size;
  const newGlyf = new Uint8Array(size);
  let cursor = 0;
  for (const [from, length] of parts) {
    newGlyf.set(new Uint8Array(font, from, length), cursor);
    cursor += (length + 1) & ~1;
  }
  const short = size / 2 <= 0xffff;
  const newLoca = new Uint8Array((glyphCount + 1) * (short ? 2 : 4));
  const locaView = new DataView(newLoca.buffer);
  offsets.forEach((offset, index) => {
    if (short) locaView.setUint16(index * 2, offset / 2);
    else locaView.setUint32(index * 4, offset);
  });
  const newHead = new Uint8Array(font.slice(head.offset, head.offset + head.length));
  const headView = new DataView(newHead.buffer);
  headView.setInt16(50, short ? 0 : 1);
  headView.setUint32(8, 0);

  const ordered = [...found.values()].filter((table) => table.tag !== "DSIG").sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const data = ordered.map((table) =>
    table.tag === "glyf"
      ? newGlyf
      : table.tag === "loca"
        ? newLoca
        : table.tag === "head"
          ? newHead
          : table.tag === "post"
            ? glyphNamesDropped(font, table)
            : new Uint8Array(font, table.offset, table.length),
  );
  const directory = 12 + ordered.length * 16;
  const total = data.reduce((sum, bytes) => sum + ((bytes.length + 3) & ~3), directory);
  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, TRUETYPE);
  outView.setUint16(4, ordered.length);
  let power = 1;
  let log = 0;
  while (power * 2 <= ordered.length) {
    power *= 2;
    log++;
  }
  outView.setUint16(6, power * 16);
  outView.setUint16(8, log);
  outView.setUint16(10, ordered.length * 16 - power * 16);
  const checksum = (bytes: Uint8Array) => {
    const padded = new Uint8Array((bytes.length + 3) & ~3);
    padded.set(bytes);
    const words = new DataView(padded.buffer);
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + words.getUint32(i)) >>> 0;
    return sum;
  };
  let place = directory;
  let headAt = 0;
  ordered.forEach((table, index) => {
    const bytes = data[index];
    const entry = 12 + index * 16;
    for (let c = 0; c < 4; c++) outView.setUint8(entry + c, table.tag.charCodeAt(c));
    outView.setUint32(entry + 4, checksum(bytes));
    outView.setUint32(entry + 8, place);
    outView.setUint32(entry + 12, bytes.length);
    out.set(bytes, place);
    if (table.tag === "head") headAt = place;
    place += (bytes.length + 3) & ~3;
  });
  outView.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out.buffer;
}

/** A `post` table without glyph names (version 3): nothing draws by name. */
function glyphNamesDropped(font: ArrayBuffer, post: Table): Uint8Array {
  const table = new Uint8Array(font.slice(post.offset, post.offset + Math.min(32, post.length)));
  if (table.length === 32) new DataView(table.buffer).setUint32(0, 0x00030000);
  return table;
}
