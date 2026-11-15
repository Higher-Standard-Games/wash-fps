/**
 * A campaign demo's comic card at the head of its video, drawn into the movie
 * frame by frame: the card dimmed and blurred behind, each panel in turn
 * filling the screen and drifting slowly closer, a crossfade from one to the
 * next, the operation's title on a gold plate; then black, and the match fades
 * in from it. The demo does not run while the comic plays.
 */

import { type CampaignCard, campaignOperationNumber, campaignStory } from "../campaign/CampaignStory";

/** How long each panel holds the screen. */
const PANEL_SECONDS = 4.5;
/** One panel crossing to the next, and the first fading in from black. */
const CROSS_SECONDS = 0.6;
/** Black at the end, before the match. */
const OUT_SECONDS = 0.8;
/** The match fading in from black. */
const GAME_IN_SECONDS = 1;
/** How much of the screen a panel may fill. */
const FILL_W = 0.9;
const FILL_H = 0.84;

export interface CampaignIntro {
  /** The intro's length; the match starts after it. */
  seconds: number;
  /** Draw the intro at `t` seconds into it. */
  draw(context: CanvasRenderingContext2D, t: number): void;
  /** The black over the match `t` seconds into it, 1 to 0 as it fades in. */
  gameFade(t: number): number;
}

/** The intro for a demo of campaign mission `missionId`, or null for any other demo, or one with no card. */
export async function loadCampaignIntro(
  missionId: string | undefined,
  signal: AbortSignal,
): Promise<CampaignIntro | null> {
  const story = missionId ? campaignStory(missionId) : null;
  const card = story?.card;
  if (!missionId || !story || !card || card.panels.length === 0) return null;
  const image = new Image();
  image.src = card.image;
  await image.decode();
  signal.throwIfAborted();
  const number = campaignOperationNumber(missionId);
  const label = number ? `Operation ${String(number).padStart(2, "0")}` : "Campaign";
  const panelsSeconds = card.panels.length * PANEL_SECONDS;
  return {
    seconds: panelsSeconds + OUT_SECONDS,
    draw: (context, t) => drawIntro(context, image, card, label, story.title, t, panelsSeconds),
    gameFade: (t) => Math.max(0, 1 - t / GAME_IN_SECONDS),
  };
}

function drawIntro(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  card: CampaignCard,
  label: string,
  title: string,
  t: number,
  panelsSeconds: number,
): void {
  const { width, height } = context.canvas;
  context.save();
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);

  // The whole card behind, dimmed and blurred, covering the frame
  const cover = Math.max(width / card.width, height / card.height);
  context.filter = "blur(18px) brightness(0.4)";
  context.drawImage(
    image,
    (width - card.width * cover) / 2,
    (height - card.height * cover) / 2,
    card.width * cover,
    card.height * cover,
  );
  context.filter = "none";

  const index = Math.min(card.panels.length - 1, Math.floor(t / PANEL_SECONDS));
  const into = Math.min(t, panelsSeconds) - index * PANEL_SECONDS;
  // The panel before stays under the one crossing in
  if (index > 0 && into < CROSS_SECONDS) drawPanel(context, image, card, index - 1, PANEL_SECONDS, 1);
  const alpha = Math.min(1, into / CROSS_SECONDS);
  drawPanel(context, image, card, index, into, alpha);

  // The operation on a gold plate, top left
  const scale = height / 1080;
  context.globalAlpha = Math.min(1, t / CROSS_SECONDS);
  const kicker = label.toUpperCase();
  const plateText = title.toUpperCase();
  context.font = `900 ${Math.round(40 * scale)}px Orbitron, sans-serif`;
  const plateWidth = context.measureText(plateText).width + 60 * scale;
  context.save();
  context.translate(64 * scale, 64 * scale);
  context.transform(1, 0, -0.09, 1, 0, 0);
  context.fillStyle = "#ffc61a";
  context.fillRect(0, 0, plateWidth, 92 * scale);
  context.fillStyle = "#14102a";
  context.font = `700 ${Math.round(20 * scale)}px Orbitron, sans-serif`;
  context.fillText(kicker, 30 * scale, 32 * scale);
  context.font = `900 ${Math.round(40 * scale)}px Orbitron, sans-serif`;
  context.fillText(plateText, 30 * scale, 76 * scale);
  context.restore();
  context.globalAlpha = 1;

  // In from black at the start, out to black at the end
  const black = Math.max(0, 1 - t / CROSS_SECONDS, Math.min(1, (t - panelsSeconds) / OUT_SECONDS));
  if (black > 0) {
    context.globalAlpha = black;
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
  }
  context.restore();
}

/** One panel filling the screen, `into` seconds into its time, drifting slowly closer. */
function drawPanel(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  card: CampaignCard,
  index: number,
  into: number,
  alpha: number,
): void {
  const { width, height } = context.canvas;
  const panel = card.panels[index];
  const fit = Math.min((width * FILL_W) / panel.w, (height * FILL_H) / panel.h);
  const scale = fit * (1 + 0.04 * Math.min(1, into / PANEL_SECONDS));
  const w = panel.w * scale;
  const h = panel.h * scale;
  const x = (width - w) / 2;
  const y = (height - h) / 2;
  context.globalAlpha = alpha;
  context.fillStyle = "#000";
  context.fillRect(x - 6, y - 6, w + 12, h + 12);
  context.drawImage(image, panel.x, panel.y, panel.w, panel.h, x, y, w, h);
  context.globalAlpha = 1;
}
