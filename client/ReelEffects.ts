/**
 * The highlight reel's comic effects, drawn on a 2D canvas over the picture:
 * speed lines across a cut that jumps ahead, the freeze frame's panel border,
 * halftone and caption burst, and the frag counter. The demo viewer draws
 * them on a canvas over the game and the video export onto each movie frame,
 * with the same code, so both show the same thing.
 *
 * Sizes are for a 1080-line picture and scale with its height; the layout
 * follows its width, so a wide screen keeps the shapes round.
 */

export interface ReelEffects {
  /** 0 – 1 across the whole wipe; the cut is at 0.5. `angle` in degrees, 0 sweeping right to left. */
  wipe: { progress: number; angle: number; seed: number } | null;
  freeze: { elapsedMs: number; totalMs: number; caption: string; seed: number } | null;
  stamp: { text: string; ageMs: number; totalMs: number } | null;
}

export const NO_REEL_EFFECTS: ReelEffects = { wipe: null, freeze: null, stamp: null };

/** The comic's colours: warm paper, ink, and the game's gold. */
const PAPER = "hsl(42, 100%, 97%)";
const INK = "#10131c";
const GOLD = "#ffd21c";
const CAPTION_FONT = "Orbitron, sans-serif";

/** The freeze frame's panel slams in this fast, and lets go over this long at its end. */
const PANEL_IN_MS = 140;
const PANEL_OUT_MS = 220;
/** The caption burst's pop: overshoot, then settle. */
const BURST_POP_MS = 240;

export function hasReelEffects(effects: ReelEffects): boolean {
  return effects.wipe !== null || effects.freeze !== null || effects.stamp !== null;
}

/** Draw `effects` over a `width`×`height` picture. The context is left as it was. */
export function drawReelEffects(
  context: CanvasRenderingContext2D,
  effects: ReelEffects,
  width: number,
  height: number,
): void {
  const unit = height / 1080;
  context.save();
  if (effects.freeze) drawFreeze(context, effects.freeze, width, height, unit);
  if (effects.stamp) drawStamp(context, effects.stamp, width, height, unit);
  if (effects.wipe) drawWipe(context, effects.wipe, width, height, unit);
  context.restore();
}

// ── Speed lines ───────────────────────────────────────────────────────────────

/**
 * Streaks of warm white and gold sweeping across the cut, thick at the
 * middle of the wipe, clear along the middle of the picture where the eye is.
 */
function drawWipe(
  context: CanvasRenderingContext2D,
  wipe: NonNullable<ReelEffects["wipe"]>,
  width: number,
  height: number,
  unit: number,
): void {
  const progress = Math.max(0, Math.min(1, wipe.progress));
  const strength = Math.sqrt(Math.sin(Math.PI * progress));
  if (strength <= 0.001) return;
  const random = seeded(wipe.seed * 7919 + 17);
  const diagonal = Math.hypot(width, height);
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate((wipe.angle * Math.PI) / 180);
  context.lineCap = "round";
  const count = 150;
  for (let i = 0; i < count; i++) {
    const y = (random() - 0.5) * diagonal;
    // Lighter along the middle, where the eye is; full toward the edges
    const away = Math.min(1, Math.abs(y) / (height * 0.45));
    const alpha = strength * (0.35 + 0.65 * away) * (0.55 + 0.45 * random());
    const length = diagonal * (0.25 + random() * 0.55);
    const speed = 0.8 + random() * 0.5;
    // Each streak slides across, centred on the screen at the cut
    const x = diagonal * (0.5 - progress) * speed * 1.6 - length / 2 + (random() - 0.5) * diagonal * 0.5;
    const tone = random();
    context.globalAlpha = alpha;
    // Mostly warm white, some gold, a few ink streaks that show on bright walls
    context.strokeStyle =
      tone < 0.22 ? "hsla(46, 100%, 62%, 1)" : tone < 0.32 ? "hsla(225, 30%, 10%, 0.8)" : "hsla(45, 100%, 96%, 1)";
    context.lineWidth = (2 + random() * 7) * unit;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + length, y);
    context.stroke();
  }
  context.restore();
}

// ── Freeze frame ──────────────────────────────────────────────────────────────

/** The still picture as a comic panel: paper gutter and ink frame, halftone corners, a caption burst. */
function drawFreeze(
  context: CanvasRenderingContext2D,
  freeze: NonNullable<ReelEffects["freeze"]>,
  width: number,
  height: number,
  unit: number,
): void {
  const t = freeze.elapsedMs;
  const fadeOut = Math.max(0, Math.min(1, (freeze.totalMs - t) / PANEL_OUT_MS));
  const slam = Math.min(1, t / PANEL_IN_MS);
  context.save();
  context.globalAlpha = fadeOut;

  // Halftone dots gathering in the corners
  drawHalftone(context, width, height, unit, Math.min(1, t / 200));

  // The panel: a paper gutter round the picture with an ink line inside,
  // slamming in from a little outside the screen
  const gutter = (18 + (1 - easeOut(slam)) * -40) * unit;
  const ink = 7 * unit;
  if (gutter > 0) {
    context.fillStyle = PAPER;
    context.fillRect(0, 0, width, gutter);
    context.fillRect(0, height - gutter, width, gutter);
    context.fillRect(0, 0, gutter, height);
    context.fillRect(width - gutter, 0, gutter, height);
  }
  context.strokeStyle = INK;
  context.lineWidth = ink;
  context.strokeRect(gutter + ink / 2, gutter + ink / 2, width - 2 * gutter - ink, height - 2 * gutter - ink);

  // The caption burst, high on the left
  const pop = popScale(t / BURST_POP_MS);
  if (pop > 0) {
    const cx = width * 0.27;
    const cy = height * 0.26;
    drawBurst(context, cx, cy, 200 * unit * pop, -0.14, freeze.seed, freeze.caption, 86 * unit * pop);
  }
  context.restore();
}

/** Ink dots on a grid, larger toward the corners and none in the middle. */
function drawHalftone(context: CanvasRenderingContext2D, width: number, height: number, unit: number, amount: number) {
  if (amount <= 0) return;
  const step = 20 * unit;
  const maxR = step * 0.42;
  context.save();
  context.fillStyle = INK;
  context.globalAlpha *= 0.5 * amount;
  const cx = width / 2;
  const cy = height / 2;
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const corner = Math.max(0, Math.hypot(dx, dy) / Math.SQRT2 - 0.62) / 0.38;
      if (corner <= 0) continue;
      context.beginPath();
      context.arc(x, y, maxR * Math.min(1, corner), 0, Math.PI * 2);
      context.fill();
    }
  }
  context.restore();
}

// ── Frag counter ──────────────────────────────────────────────────────────────

/** The count so far, popping up on the right as each frag lands, clear of the kill feed and the shot card. */
function drawStamp(
  context: CanvasRenderingContext2D,
  stamp: NonNullable<ReelEffects["stamp"]>,
  width: number,
  height: number,
  unit: number,
): void {
  const pop = popScale(stamp.ageMs / BURST_POP_MS);
  const fade = Math.max(0, Math.min(1, (stamp.totalMs - stamp.ageMs) / 200));
  if (pop <= 0 || fade <= 0) return;
  context.save();
  context.globalAlpha = fade;
  const seed = Number.parseInt(stamp.text, 10) || stamp.text.length;
  drawBurst(context, width * 0.86, height * 0.52, 96 * unit * pop, 0.12, seed, stamp.text, 78 * unit * pop);
  context.restore();
}

// ── Shared shapes ─────────────────────────────────────────────────────────────

/** A jagged comic burst in gold with an ink outline, with `text` across it. */
function drawBurst(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  tilt: number,
  seed: number,
  text: string,
  fontSize: number,
): void {
  if (radius <= 0) return;
  const random = seeded(seed * 104729 + 3);
  const points = 18;
  context.save();
  context.translate(cx, cy);
  context.rotate(tilt);
  // Wider than tall, as a shout is
  context.scale(1.35, 1);
  context.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const angle = (i / (points * 2)) * Math.PI * 2;
    const r = radius * (i % 2 === 0 ? 1 - random() * 0.12 : 0.7 + random() * 0.08);
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.fillStyle = GOLD;
  context.fill();
  context.lineJoin = "round";
  context.lineWidth = Math.max(2, radius * 0.045);
  context.strokeStyle = INK;
  context.stroke();
  context.scale(1 / 1.35, 1);

  // The words: ink with a paper edge, leaning forward
  context.transform(1, 0, -0.18, 1, 0, 0);
  context.textAlign = "center";
  context.textBaseline = "middle";
  let size = fontSize;
  context.font = `700 ${size}px ${CAPTION_FONT}`;
  const room = radius * 2.3;
  const measured = context.measureText(text).width;
  if (measured > room) {
    size *= room / measured;
    context.font = `700 ${size}px ${CAPTION_FONT}`;
  }
  context.lineWidth = Math.max(2, size * 0.14);
  context.strokeStyle = PAPER;
  context.strokeText(text, 0, size * 0.04);
  context.fillStyle = INK;
  context.fillText(text, 0, size * 0.04);
  context.restore();
}

/** 0 → overshoot → 1 over t in 0..1, and 1 after. */
function popScale(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // Out past full size, then back
  return t < 0.6 ? (t / 0.6) * 1.18 : 1.18 - ((t - 0.6) / 0.4) * 0.18;
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** A small repeatable random sequence, so every frame of a wipe draws the same streaks. */
function seeded(seed: number): () => number {
  let state = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}
