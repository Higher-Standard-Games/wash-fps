import type { CinematicDemoPlayer, CinematicRecipe } from "../CinematicDemoPlayer";
import { drawReelEffects } from "../ReelEffects";

/** Reel graphics share their copy/data with playback; controls stay outside this surface. */
export function drawReelOverlay(
  context: CanvasRenderingContext2D,
  player: CinematicDemoPlayer,
  recipe: CinematicRecipe,
): void {
  const { width, height } = context.canvas;
  // The comic effects and the scene's tag first, at the movie's own size, so the veil covers them as it covers the picture
  drawReelEffects(context, player.getEffects(), width, height);
  context.save();
  context.scale(width / 1920, height / 1080);
  const veil = player.getVeil();
  if (veil.opacity > 0) {
    context.globalAlpha = veil.opacity;
    context.fillStyle = veil.color;
    context.fillRect(0, 0, 1920, 1080);
    context.globalAlpha = 1;
  }
  const centered = (text: string, y: number, size: number, color = "#ffffff") => {
    context.font = `700 ${size}px Orbitron, sans-serif`;
    context.fillStyle = color;
    context.textAlign = "center";
    context.fillText(text, 960, y, 1700);
  };
  if (player.isShowingTitle()) {
    context.fillStyle = "#080d17";
    context.fillRect(0, 0, 1920, 1080);
    centered("HIGHLIGHTS", 315, 38, "#ffd21c");
    const title = player.getTitle();
    const sides = title?.sides.map((side) => `${side.label ? `${side.label}: ` : ""}${side.names.join(", ")}`) ?? [];
    centered(sides.join(sides.length === 2 ? "  vs  " : " · "), 510, 52);
    if (title?.more) centered(`+ ${title.more} players`, 595, 28);
    centered(`${recipe.header.map} · ${recipe.header.gametype}`, 735, 30, "#b9cbe5");
  } else if (player.getState() === "ended") {
    context.fillStyle = "#080d17";
    context.fillRect(0, 0, 1920, 1080);
    const summary = player.getSummary();
    centered("HIGHLIGHTS", 290, 38, "#ffd21c");
    centered(`${summary?.frags ?? 0} frag scenes · ${summary?.tricks ?? 0} trick jumps`, 430, 38);
    if (summary?.topFragger) centered(`${summary.topFragger.name} · ${summary.topFragger.frags} frags`, 565, 46);
    if (summary?.best) centered(`${summary.best.title} · ${summary.best.player}`, 705, 30, "#b9cbe5");
  }
  context.restore();
}
