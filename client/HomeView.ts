/**
 * HomeView — the lobby's first page: three full-height cards, Quick play,
 * Campaign and Play online. Each does exactly what its key in the rail does;
 * the page only puts the three ways into the game first, big and plain, so a
 * new player meets a choice before the mode list, the rooms and the chat.
 */

import { background } from "../../../engine/core/AsyncErrors";
import { resolvePublicUrl } from "../../../engine/core/PublicUrls";
import { button, el } from "./settings/SettingsFields";

/** Quick play's match shots: file under /images/home, and where the fighter stands across it (%). */
const QUICK_PLAY_SHOTS: readonly [string, number][] = [
  ["quick-01", 36],
  ["quick-02", 24],
  ["quick-03", 52],
  ["quick-04", 26],
  ["quick-05", 33],
  ["quick-06", 94],
  ["quick-07", 25],
  ["quick-08", 35],
  ["quick-09", 38],
  ["quick-10", 78],
];
/** Quick play's ground: block size (px), and how full each row of blocks is, from the solid edge up. */
const BLOCK = 18;
const BLOCK_ROWS = [0.9, 0.65, 0.4, 0.2, 0.07];
const BLOCK_COLUMNS = 56;
/** Campaign's ground: gap then line (px), from the solid edge up, thinning like its stripes. */
const STRIPES: readonly [number, number][] = [
  [3, 10],
  [5, 7],
  [7, 5],
  [9, 3],
  [11, 2],
  [13, 1],
];
/** Play online's ground: halftone dot spacing (px) and radius per row, from the solid edge up. */
const DOT = 12;
const DOT_RADII = [6.4, 5.4, 4.5, 3.6, 2.8, 2, 1.2];

/** How long a shot holds, and how long the change to the next one takes. */
const SHOT_MS = 7000;
const FADE_MS = 1500;
/** How far a shot drifts from its centre each way (% of the card), and the zoom that keeps its edges out of sight. */
const DRIFT = 3;
const DRIFT_ZOOM = 1.14;
const CAMPAIGN_STREET = "/images/campaign/street.webp";
const CAMPAIGN_SQUAD = "/images/campaign/squad.webp";
/** Play online's four modes, in their own colours, behind the card's text. */
const MODES: readonly [string, string][] = [
  ["Duel", "hsl(182 95% 52%)"],
  ["Amphi", "hsl(100 85% 52%)"],
  ["FFA", "hsl(46 100% 57%)"],
  ["S&D", "hsl(322 95% 62%)"],
];

export interface HomeActions {
  quickPlay(): void;
  campaign(): void;
  playOnline(): void;
}

function image(className: string, path: string): HTMLImageElement {
  const img = el("img", className);
  img.src = resolvePublicUrl(path);
  img.alt = "";
  img.decoding = "async";
  img.draggable = false;
  return img;
}

/**
 * Quick play's art: the match shots one after another, in random order. Each
 * drifts slowly one way, then the next fades in over it. The next shot loads
 * only when its turn comes, and the reel waits while Home is off screen.
 */
class ShotReel {
  readonly root = el("span", "home__art");
  private readonly layers: [HTMLImageElement, HTMLImageElement];
  private front = 0;
  private current = -1;
  private timer: number | undefined;
  private stopped = false;

  constructor(private readonly shots: readonly [string, number][]) {
    this.layers = [this.layer(), this.layer()];
    this.root.append(...this.layers);
    background(this.advance(), "Quick play shots");
  }

  destroy(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
  }

  private layer(): HTMLImageElement {
    const img = el("img", "home__shot");
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    img.style.transitionDuration = `${FADE_MS}ms`;
    return img;
  }

  private async advance(): Promise<void> {
    if (this.root.isConnected || this.current < 0) {
      const index = this.pick();
      const [file, x] = this.shots[index];
      const next = this.layers[this.front ^ 1];
      next.src = resolvePublicUrl(`/images/home/${file}.webp`);
      next.style.objectPosition = `${x}% 50%`;
      // A shot that fails to decode still takes its turn; it shows the ink behind
      await next.decode?.().catch(() => undefined);
      if (this.stopped) return;
      this.drift(next);
      next.classList.add("home__shot--on");
      this.layers[this.front].classList.remove("home__shot--on");
      this.front ^= 1;
      this.current = index;
    }
    if (this.stopped) return;
    this.timer = window.setTimeout(() => background(this.advance(), "Quick play shots"), SHOT_MS);
  }

  /** Any shot but the one on screen. */
  private pick(): number {
    if (this.shots.length < 2) return 0;
    let index = this.current;
    while (index === this.current) index = Math.floor(Math.random() * this.shots.length);
    return index;
  }

  /** A slow pan across the card in a random direction, through both fades. */
  private drift(layer: HTMLImageElement): void {
    const angle = Math.random() * Math.PI * 2;
    const dx = Math.cos(angle) * DRIFT;
    const dy = Math.sin(angle) * DRIFT;
    for (const running of layer.getAnimations?.() ?? []) running.cancel();
    layer.animate?.(
      [
        { transform: `translate(${-dx}%, ${-dy}%) scale(${DRIFT_ZOOM})` },
        { transform: `translate(${dx}%, ${dy}%) scale(${DRIFT_ZOOM})` },
      ],
      { duration: SHOT_MS + FADE_MS * 2, easing: "linear", fill: "forwards" },
    );
  }
}

/** The broken top edge of a card's ground: a mask tile, repeated across, and its height. */
interface Edge {
  svg: string;
  height: number;
}

function edgeTile(width: number, height: number, shapes: string[]): Edge {
  return {
    svg: `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'>${shapes.join("")}</svg>`,
    height,
  };
}

/** Quick play: rows of square blocks, thinning upward, a new scatter each load. */
function blockEdge(): Edge {
  const rects: string[] = [];
  BLOCK_ROWS.forEach((fill, row) => {
    const y = (BLOCK_ROWS.length - 1 - row) * BLOCK;
    for (let col = 0; col < BLOCK_COLUMNS; col++) {
      if (Math.random() < fill) rects.push(`<rect x='${col * BLOCK}' y='${y}' width='${BLOCK}' height='${BLOCK}'/>`);
    }
  });
  return edgeTile(BLOCK * BLOCK_COLUMNS, BLOCK * BLOCK_ROWS.length, rects);
}

/** Campaign: full-width lines, thinner and further apart going up. */
function stripeEdge(): Edge {
  const height = STRIPES.reduce((sum, [gap, line]) => sum + gap + line, 0);
  const rects: string[] = [];
  let bottom = height;
  for (const [gap, line] of STRIPES) {
    bottom -= gap + line;
    rects.push(`<rect x='0' y='${bottom}' width='8' height='${line}'/>`);
  }
  return edgeTile(8, height, rects);
}

/** Play online: a halftone, its dots shrinking going up, each row set half a dot along. */
function dotEdge(): Edge {
  const height = DOT * DOT_RADII.length;
  const circles: string[] = [];
  DOT_RADII.forEach((r, row) => {
    const cy = height - DOT * row - DOT / 2;
    const offset = row % 2 === 0 ? DOT / 2 : 0;
    for (const cx of [offset, offset + DOT, offset + DOT * 2]) circles.push(`<circle cx='${cx}' cy='${cy}' r='${r}'/>`);
  });
  return edgeTile(DOT * 2, height, circles);
}

/** A card's text sits on its colour, solid below and breaking into the art along the edge. */
function ground(edge: Edge): HTMLElement {
  const ground = el("span", "home__ground");
  ground.style.setProperty("--edge", `url("data:image/svg+xml,${encodeURIComponent(edge.svg)}")`);
  ground.style.setProperty("--edge-h", `${edge.height}px`);
  return ground;
}

export class HomeView {
  readonly root = el("div", "lobby__page home");
  private readonly quick: HTMLButtonElement;
  private readonly reel = new ShotReel(QUICK_PLAY_SHOTS);

  constructor(actions: HomeActions) {
    const cards = el("div", "home__cards");
    this.quick = this.card(
      "quick",
      "Quick play",
      "Free For All",
      this.reel.root,
      actions.quickPlay,
      ground(blockEdge()),
    );
    cards.append(
      this.quick,
      this.card(
        "campaign",
        "Campaign",
        "Single player challenge",
        this.campaignArt(),
        actions.campaign,
        ground(stripeEdge()),
      ),
      this.card(
        "online",
        "Play online",
        "Multiplayer lobbies",
        this.onlineArt(),
        actions.playOnline,
        ground(dotEdge()),
      ),
    );
    this.root.append(cards);
  }

  destroy(): void {
    this.reel.destroy();
  }

  /** Quick play is off when its key in the rail is: no lobby, or another room open. */
  setQuickPlayEnabled(enabled: boolean): void {
    this.quick.disabled = !enabled;
  }

  private card(
    kind: string,
    title: string,
    caption: string,
    art: HTMLElement,
    action: () => void,
    ground: HTMLElement,
  ): HTMLButtonElement {
    const card = button(`home__card home__card--${kind}`);
    card.setAttribute("aria-label", `${title}: ${caption}`);
    const face = el("span", "home__face");
    const text = el("span", "home__text");
    // One word to a line, set once: the title keeps its shape while the card grows
    const heading = el("span", "home__title");
    for (const word of title.split(" ")) heading.append(el("span", "home__line", word));
    text.append(heading, el("span", "home__caption", caption));
    face.append(art, el("span", "home__shade"), ground, text);
    card.append(face);
    card.addEventListener("click", () => {
      if (!card.disabled) action();
    });
    return card;
  }

  /** The campaign page's banner: its street and squad, drifting like a handheld camera. */
  private campaignArt(): HTMLElement {
    const art = el("span", "home__art");
    art.append(
      image("home__street", CAMPAIGN_STREET),
      image("home__squad", CAMPAIGN_SQUAD),
      el("span", "home__stripes"),
    );
    return art;
  }

  /** The four modes' names in their colours, stacked behind the text. */
  private onlineArt(): HTMLElement {
    const art = el("span", "home__art home__art--modes");
    for (const [name, colour] of MODES) {
      const word = el("span", "home__mode", name);
      word.style.setProperty("--mode", colour);
      art.append(word);
    }
    return art;
  }
}
