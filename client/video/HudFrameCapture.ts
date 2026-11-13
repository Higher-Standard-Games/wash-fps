import { UIScale } from "../../../../engine/ui/UIScale";
import { subsetTrueType } from "./ExportFontSubset";
import { abortable } from "./MovieClock";

const XHTML = "http://www.w3.org/1999/xhtml";
const SKIPPED = new Set(["SCRIPT", "STYLE", "LINK", "TEMPLATE", "NOSCRIPT", "META", "IFRAME"]);
/** A frame's picture is frozen in place: nothing in it moves, blurs or eases by itself. */
const STILL = `*,*::before,*::after{animation:none!important;transition:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}`;
const MARK = "data-movie-hud";
/** A CSS `url(...)`, its quotes optional. */
const URL_PATTERN = /url\(\s*(["']?)([^"')]+)\1\s*\)/;
const CLOSING = encodeURIComponent("</foreignObject></svg>");
/** Characters every font keeps: Latin-1, punctuation and arrows; any other is added when the HUD shows it. */
const BASE_CHARACTERS = [
  [0x20, 0xff],
  [0x2010, 0x205e],
  [0x2190, 0x21ff],
].flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i));
/** A CSS `content` string, and the escapes in one. */
const CONTENT_PATTERN = /content:\s*"((?:[^"\\]|\\.)*)"/g;
const CSS_ESCAPE = /\\([0-9a-fA-F]{1,6})\s?|\\(.)/g;
const WEIGHTS: Record<string, number> = { normal: 400, bold: 700 };
const weightOf = (value: string) => WEIGHTS[value] ?? (Number.parseInt(value, 10) || 400);
const familiesOf = (value: string) =>
  value.split(",").map((family) =>
    family
      .trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase(),
  );

/** The face CSS font matching picks for weight `want` among `weights`. */
export function matchWeight(weights: readonly number[], want: number): number | undefined {
  const sorted = [...new Set(weights)].sort((a, b) => a - b);
  if (sorted.includes(want)) return want;
  const heavier = sorted.filter((weight) => weight > want);
  const lighter = sorted.filter((weight) => weight < want).reverse();
  if (want >= 400 && want <= 500) return heavier.find((weight) => weight <= 500) ?? lighter[0] ?? heavier[0];
  if (want < 400) return lighter[0] ?? heavier[0];
  return heavier[0] ?? lighter[0];
}

/** Scripts shaped from glyphs no character names: a font showing one is kept whole. */
const SHAPED = (code: number) => (code >= 0x0900 && code <= 0x0dff) || (code >= 0xa8e0 && code <= 0xa8ff);

interface Animated {
  target: Element;
  pseudo: string | null;
  properties: Set<string>;
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const kebab = (property: string) =>
  property.startsWith("--") ? property : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
/** Keyframe fields that are not styles; `visibility` is how the page hides the live HUD, so it is not read back. */
const TIMING_KEYS = new Set(["offset", "computedOffset", "easing", "composite", "visibility"]);

/**
 * The page's own HUD, drawn into a movie frame: its markup and style, at the
 * movie's size, through an SVG image. The HUD's CSS animations and
 * transitions are paused and stepped on the movie's clock, so a frame shows
 * them where the movie's time has them, however long the frame took to make.
 */
export class HudFrameCapture {
  private styleKey = "";
  /** The image up to the HUD's markup, URL-encoded once per style change. */
  private opening = "";
  private readonly data = new Map<string, Promise<string>>();
  private readonly fontBytes = new Map<string, Promise<ArrayBuffer>>();
  /** What the HUD has shown: its fonts carry these glyphs. */
  private readonly characters = new Set<number>(BASE_CHARACTERS);
  private shaped = false;
  /** The family, weight and style of everything the HUD has written: its fonts carry these faces. */
  private readonly faces = new Set<string>();
  private readonly started = new Map<Animation, number>();
  private readonly finished = new WeakSet<Animation>();
  private last: { markup: string; image: HTMLImageElement } | null = null;

  /** `excluded` names the page's own elements, which are not part of the HUD. */
  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly excluded: (element: Element) => boolean,
  ) {}

  /** The HUD at movie time `nowMs`, or null when nothing of it is on screen. */
  async frame(nowMs: number, signal: AbortSignal): Promise<HTMLImageElement | null> {
    const animated = this.stepAnimations(nowMs);
    const roots = [...document.body.children].filter(
      (element) => !SKIPPED.has(element.tagName) && !this.excluded(element) && this.shown(element),
    );
    if (!roots.length) {
      this.last = null;
      return null;
    }
    const marks = new Map<Element, string>();
    const pseudoRules: string[] = [];
    for (const entry of animated) {
      let mark = marks.get(entry.target);
      if (mark === undefined) {
        mark = String(marks.size);
        marks.set(entry.target, mark);
      }
      if (!entry.pseudo) continue;
      const computed = getComputedStyle(entry.target, entry.pseudo);
      const declarations = [...entry.properties].map(
        (property) => `${property}:${computed.getPropertyValue(property)}!important`,
      );
      pseudoRules.push(`[${MARK}="${mark}"]${entry.pseudo}{${declarations.join(";")}}`);
    }
    const inline = new Map<Element, Set<string>>();
    for (const entry of animated) {
      if (entry.pseudo) continue;
      const properties = inline.get(entry.target) ?? new Set<string>();
      for (const property of entry.properties) properties.add(property);
      inline.set(entry.target, properties);
    }
    const html = document.createElementNS(XHTML, "html");
    const body = document.createElementNS(XHTML, "body");
    for (const [from, to] of [
      [document.documentElement, html],
      [document.body, body],
    ] as const) {
      const style = from.getAttribute("style");
      if (style) to.setAttribute("style", style);
      const classes = [...from.classList].filter((name) => !name.startsWith("video-export"));
      if (classes.length) to.setAttribute("class", classes.join(" "));
    }
    html.style.setProperty("width", `${this.width}px`);
    html.style.setProperty("height", `${this.height}px`);
    body.style.setProperty("margin", "0");
    body.style.setProperty("width", `${this.width}px`);
    body.style.setProperty("height", `${this.height}px`);
    body.style.setProperty("overflow", "hidden");
    body.style.setProperty("background", "transparent");
    for (const root of roots) {
      const copy = await this.copy(root, marks, inline, signal);
      if (copy) body.append(copy);
    }
    if (pseudoRules.length) {
      const sheet = document.createElementNS(XHTML, "style");
      sheet.textContent = pseudoRules.join("");
      html.append(sheet);
    }
    html.append(body);
    // After the copy, which notes any character the fonts do not carry yet
    await abortable(this.refreshStyle(), signal);
    const markup = new XMLSerializer().serializeToString(html);
    if (this.last?.markup === markup) return this.last.image;
    // A data URL: an SVG image from a blob URL taints the canvas it is drawn on, and the encoder refuses it
    const image = new Image(this.width, this.height);
    image.decoding = "async";
    image.src = `${this.opening}${encodeURIComponent(markup)}${CLOSING}`;
    await abortable(image.decode(), signal);
    this.last = { markup, image };
    return image;
  }

  /** Let the page's animations run again, from where the movie left them. */
  dispose(): void {
    for (const animation of this.started.keys()) {
      try {
        animation.play();
      } catch {}
    }
    this.started.clear();
    this.last = null;
  }

  private shown(element: Element): boolean {
    if (element instanceof HTMLElement && element.hidden) return false;
    return getComputedStyle(element).display !== "none";
  }

  private inHud(target: Element): boolean {
    let top: Element = target;
    while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
    return top.parentElement === document.body && !this.excluded(top);
  }

  /** Pause each HUD animation where it started on the movie clock, and move it to `nowMs`. */
  private stepAnimations(nowMs: number): Animated[] {
    const animated: Animated[] = [];
    for (const animation of document.getAnimations()) {
      const effect = animation.effect as KeyframeEffect | null;
      const target = effect?.target;
      if (!effect || !target || !this.inHud(target)) continue;
      if (!this.finished.has(animation)) {
        let start = this.started.get(animation);
        if (start === undefined) {
          start = nowMs;
          this.started.set(animation, start);
          animation.pause();
        }
        const elapsed = nowMs - start;
        const end = Number(effect.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY);
        if (Number.isFinite(end) && elapsed >= end) {
          // Finishing it ends it as running would: a filled end state stays, `animationend` fires
          this.started.delete(animation);
          this.finished.add(animation);
          animation.finish();
        } else animation.currentTime = elapsed;
      }
      if (effect.getComputedTiming().progress === null) continue;
      const properties = new Set<string>();
      for (const keyframe of effect.getKeyframes())
        for (const property of Object.keys(keyframe)) if (!TIMING_KEYS.has(property)) properties.add(kebab(property));
      if (properties.size) animated.push({ target, pseudo: effect.pseudoElement, properties });
    }
    for (const animation of this.started.keys()) {
      if (animation.playState === "idle") this.started.delete(animation);
    }
    return animated;
  }

  private async copy(
    node: Node,
    marks: Map<Element, string>,
    inline: Map<Element, Set<string>>,
    signal: AbortSignal,
  ): Promise<Node | null> {
    if (node.nodeType === Node.TEXT_NODE) {
      this.note(node.nodeValue ?? "");
      return node.cloneNode(false);
    }
    if (!(node instanceof Element) || SKIPPED.has(node.tagName)) return null;
    let copy: Element;
    if (node instanceof HTMLCanvasElement) {
      copy = document.createElementNS(XHTML, "img");
      for (const attribute of node.attributes) copy.setAttribute(attribute.name, attribute.value);
      copy.setAttribute("src", node.width && node.height ? node.toDataURL() : "");
    } else {
      copy = node.cloneNode(false) as Element;
      if (node instanceof HTMLImageElement && node.currentSrc)
        copy.setAttribute("src", await abortable(this.inlined(node.currentSrc), signal));
      if (node instanceof HTMLInputElement) {
        copy.setAttribute("value", node.value);
        this.note(node.value);
      }
    }
    const style = copy.getAttribute("style");
    if (style?.includes("url("))
      copy.setAttribute("style", await abortable(this.inlineUrls(style, document.baseURI), signal));
    const mark = marks.get(node);
    if (mark !== undefined && marks.has(node)) copy.setAttribute(MARK, mark);
    const properties = inline.get(node);
    if (properties && (copy instanceof HTMLElement || copy instanceof SVGElement)) {
      const computed = getComputedStyle(node);
      for (const property of properties)
        copy.style.setProperty(property, computed.getPropertyValue(property), "important");
    }
    if ([...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.nodeValue?.trim()))
      this.noteFace(getComputedStyle(node));
    for (const child of node.childNodes) {
      const copied = await this.copy(child, marks, inline, signal);
      if (copied) copy.append(copied);
    }
    return copy;
  }

  /**
   * The page's style as the image needs it: every rule but keyframes, with
   * its fonts and pictures inlined (an image loads nothing), `:root` read as
   * the copy's own root, and the scale variables of the movie's size.
   */
  private async refreshStyle(): Promise<void> {
    const sheets = [...document.styleSheets];
    let key = String(sheets.length);
    for (const sheet of sheets) {
      try {
        key += `:${sheet.cssRules.length}`;
      } catch {
        key += ":x";
      }
    }
    const scale = document.getElementById("ui-scale-variables")?.textContent ?? "";
    key += `:${scale.length}:${this.characters.size}:${this.shaped}:${this.faces.size}`;
    if (key === this.styleKey) return;
    const parts: string[] = [];
    const fonts = new Map<string, { rule: CSSFontFaceRule; base: string }>();
    const collect = async (rules: CSSRuleList, base: string) => {
      for (const rule of rules) {
        if (rule instanceof CSSKeyframesRule) continue;
        if (rule instanceof CSSImportRule) {
          if (rule.styleSheet) {
            try {
              await collect(rule.styleSheet.cssRules, rule.styleSheet.href ?? base);
            } catch {}
          }
          continue;
        }
        let text = rule.cssText;
        if (rule instanceof CSSFontFaceRule) {
          fonts.set(text, { rule, base });
          continue;
        }
        for (const [, content] of text.matchAll(CONTENT_PATTERN))
          this.note(
            content.replace(CSS_ESCAPE, (_, hex: string | undefined, plain: string | undefined) =>
              hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : (plain ?? ""),
            ),
          );
        if (text.includes("url(")) text = await this.inlineUrls(text, base);
        parts.push(text.replace(/:root\b/g, "html"));
      }
    };
    for (const sheet of sheets) {
      if (sheet.ownerNode instanceof Element && sheet.ownerNode.id === "ui-scale-variables") continue;
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      await collect(rules, sheet.href ?? document.baseURI);
    }
    for (const text of this.chooseFaces([...fonts.values()].map(({ rule }) => rule)))
      parts.push(await this.inlineFont(text, fonts.get(text)!.base));
    // Characters the stylesheet itself writes were noted on the way
    key = key.replace(/:\d+:(true|false):\d+$/, `:${this.characters.size}:${this.shaped}:${this.faces.size}`);
    parts.push(
      UIScale.getInstance()
        .variablesFor(this.width, this.height)
        .replace(/:root\b/g, "html"),
    );
    parts.push(STILL);
    this.opening = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">` +
        `<style>${escapeXml(parts.join("\n"))}</style>` +
        `<foreignObject x="0" y="0" width="${this.width}" height="${this.height}">`,
    )}`;
    this.styleKey = key;
    this.last = null;
  }

  private noteFace(style: CSSStyleDeclaration): void {
    const weight = weightOf(style.fontWeight);
    for (const family of familiesOf(style.fontFamily)) this.faces.add(`${family}|${weight}|${style.fontStyle}`);
  }

  /** The font faces, by their rule text, that draw what the HUD has written. */
  private chooseFaces(rules: CSSFontFaceRule[]): string[] {
    const byFamily = new Map<string, Array<{ text: string; weight: number; italic: boolean }>>();
    for (const rule of rules) {
      const family = familiesOf(rule.style.getPropertyValue("font-family"))[0];
      const weight = weightOf(rule.style.getPropertyValue("font-weight").split(/s+/)[0] || "normal");
      const italic = /italic|oblique/.test(rule.style.getPropertyValue("font-style"));
      const list = byFamily.get(family) ?? [];
      list.push({ text: rule.cssText, weight, italic });
      byFamily.set(family, list);
    }
    const chosen = new Set<string>();
    for (const face of this.faces) {
      const [family, weightText, style] = face.split("|");
      const all = byFamily.get(family);
      if (!all) continue;
      const italic = style !== "normal";
      const candidates = all.some((entry) => entry.italic === italic)
        ? all.filter((entry) => entry.italic === italic)
        : all;
      const weight = matchWeight(
        candidates.map((entry) => entry.weight),
        Number(weightText),
      );
      for (const entry of candidates) if (entry.weight === weight) chosen.add(entry.text);
    }
    return [...chosen];
  }

  private note(text: string): void {
    for (const character of text) {
      const code = character.codePointAt(0)!;
      if (this.characters.has(code)) continue;
      this.characters.add(code);
      if (SHAPED(code)) this.shaped = true;
    }
  }

  /** A font face with its TrueType files cut down to the characters the HUD shows. */
  private async inlineFont(text: string, base: string): Promise<string> {
    const pattern = new RegExp(URL_PATTERN, "g");
    const found = [...text.matchAll(pattern)];
    const replacements = await Promise.all(
      found.map(async (match) => {
        const raw = match[2];
        if (raw.startsWith("data:")) return match[0];
        try {
          const url = new URL(raw, base).href;
          let bytes = this.fontBytes.get(url);
          if (!bytes) {
            bytes = fetch(url).then((response) => {
              if (!response.ok) throw new Error(`${url}: ${response.status}`);
              return response.arrayBuffer();
            });
            this.fontBytes.set(url, bytes);
          }
          const whole = await bytes;
          const subset = this.shaped ? null : subsetTrueType(whole, this.characters);
          return `url("${await dataUrl(new Blob([subset ?? whole], { type: "font/ttf" }))}")`;
        } catch {
          return match[0];
        }
      }),
    );
    let index = 0;
    return text.replace(pattern, () => replacements[index++]);
  }

  private async inlineUrls(text: string, base: string): Promise<string> {
    const pattern = new RegExp(URL_PATTERN, "g");
    const found = [...text.matchAll(pattern)];
    const replacements = await Promise.all(
      found.map(async (match) => {
        const raw = match[2];
        if (raw.startsWith("data:") || raw.startsWith("#")) return match[0];
        try {
          return `url("${await this.inlined(new URL(raw, base).href)}")`;
        } catch {
          return match[0];
        }
      }),
    );
    let index = 0;
    return text.replace(pattern, () => replacements[index++]);
  }

  /** A resource as a data URL, fetched once per export. */
  private inlined(url: string): Promise<string> {
    if (url.startsWith("data:")) return Promise.resolve(url);
    let pending = this.data.get(url);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url}: ${response.status}`);
        return await dataUrl(await response.blob());
      })();
      this.data.set(url, pending);
      pending.catch(() => this.data.delete(url));
    }
    return pending;
  }
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
