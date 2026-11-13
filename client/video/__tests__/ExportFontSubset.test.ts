import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { glyphsFor, subsetTrueType } from "../ExportFontSubset";

const fontFile = (path: string) => {
  const bytes = readFileSync(resolve(__dirname, "../../../../../../public/engine/fonts", path));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

function glyphBytes(font: ArrayBuffer, glyph: number): Uint8Array {
  const view = new DataView(font);
  const count = view.getUint16(4);
  const table = (tag: string) => {
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16;
      if (String.fromCharCode(...new Uint8Array(font, at, 4)) === tag)
        return { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) };
    }
    throw new Error(tag);
  };
  const head = table("head");
  const loca = table("loca");
  const glyf = table("glyf");
  const long = view.getInt16(head.offset + 50) === 1;
  const at = (g: number) => (long ? view.getUint32(loca.offset + g * 4) : view.getUint16(loca.offset + g * 2) * 2);
  return new Uint8Array(font, glyf.offset + at(glyph), at(glyph + 1) - at(glyph));
}

const LATIN = Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i);

describe("export font subset", () => {
  it("keeps the outlines it is asked for, under the same glyph IDs, and drops the rest", () => {
    const font = fontFile("Rajdhani/Rajdhani-Bold.ttf");
    const subset = subsetTrueType(font, LATIN)!;
    expect(subset.byteLength).toBeLessThan(font.byteLength / 3);
    const before = glyphsFor(font, LATIN);
    const after = glyphsFor(subset, LATIN);
    expect([...after]).toEqual([...before]);
    for (const glyph of before.values()) {
      const original = glyphBytes(font, glyph);
      const kept = glyphBytes(subset, glyph);
      // The same outline, padded to a two-byte boundary
      expect([...kept.subarray(0, original.length)]).toEqual([...original]);
      expect(kept.length - original.length).toBeLessThan(2);
    }
    // A Devanagari letter keeps its slot with nothing in it
    const ka = glyphsFor(font, [0x0915]).get(0x0915)!;
    expect(glyphBytes(font, ka).length).toBeGreaterThan(0);
    expect(glyphBytes(subset, ka).length).toBe(0);
  });

  it("writes table checksums a sanitizer accepts", () => {
    const subset = new DataView(subsetTrueType(fontFile("Orbitron/static/Orbitron-Black.ttf"), LATIN)!);
    let sum = 0;
    for (let i = 0; i < subset.byteLength; i += 4) sum = (sum + subset.getUint32(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
  });

  it("leaves fonts that are not TrueType outlines alone", () => {
    const otf = new ArrayBuffer(64);
    new DataView(otf).setUint32(0, 0x4f54544f);
    expect(subsetTrueType(otf, LATIN)).toBeNull();
  });
});
