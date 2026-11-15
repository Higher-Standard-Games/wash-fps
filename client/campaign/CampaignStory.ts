/**
 * What the campaign shows for each mission: its name, line and comic card.
 * The rules (map, gametype, bots, models) come from the lobby; this is keyed by
 * the same mission ids.
 */

/** A framed panel of a comic card, in the card image's pixels. */
export interface CardPanel {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CampaignCard {
  /** The full card, shown before the mission. */
  image: string;
  /** A smaller copy for the mission grid. */
  thumb: string;
  width: number;
  height: number;
  /** The panels in reading order; each is shown on its own, the rest blurred. */
  panels: CardPanel[];
  /** Which part of the card the grid's thumbnail shows (CSS object-position). */
  thumbFocus: string;
}

export interface CampaignStory {
  title: string;
  /** One line under the title on the mission card. */
  hook: string;
  rival: string;
  card: CampaignCard;
}

const CARD_W = 1536;
const CARD_H = 864;

function card(n: number, panels: CardPanel[], thumbFocus: string): CampaignCard {
  return {
    image: `/images/campaign/card${n}.webp`,
    thumb: `/images/campaign/card${n}-thumb.webp`,
    width: CARD_W,
    height: CARD_H,
    panels,
    thumbFocus,
  };
}

const STORIES: Record<string, CampaignStory> = {
  "cartel-contract": {
    title: "Cartel Contract",
    hook: "Survive three rounds against the Cartel King.",
    rival: "Cartel King",
    card: card(
      1,
      [
        { x: 14, y: 14, w: 707, h: 836 },
        { x: 739, y: 14, w: 783, h: 836 },
      ],
      "78% 30%",
    ),
  },
  "street-riot": {
    title: "Street Riot",
    hook: "Dropped straight into a Sector 1 street riot.",
    rival: "Street Rioters",
    card: card(
      2,
      [
        { x: 10, y: 10, w: 747, h: 844 },
        { x: 774, y: 10, w: 753, h: 844 },
      ],
      "70% 45%",
    ),
  },
  "concrete-sabotage": {
    title: "Concrete Strike",
    hook: "Plant the EMP before Monday's billing cycle.",
    rival: "Metropol Riot Cops",
    card: card(
      3,
      [
        { x: 6, y: 5, w: 1524, h: 90 },
        { x: 6, y: 99, w: 735, h: 758 },
        { x: 751, y: 99, w: 779, h: 758 },
      ],
      "80% 50%",
    ),
  },
  "glitch-duel": {
    title: "Turf Duel",
    hook: "The Glitch Punks' boss wants your head.",
    rival: "Glitch Punk Leader",
    card: card(
      4,
      [
        { x: 8, y: 7, w: 684, h: 848 },
        { x: 708, y: 7, w: 821, h: 848 },
      ],
      "75% 40%",
    ),
  },
};

/** The story for a mission id, or null for one this client has no art for. */
export function campaignStory(missionId: string): CampaignStory | null {
  return STORIES[missionId] ?? null;
}
