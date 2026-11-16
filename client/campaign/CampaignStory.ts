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

export interface CampaignBriefing {
  goal: string;
  points: string[];
}

export interface CampaignStory {
  title: string;
  /** One line under the title on the mission card. */
  hook: string;
  rival: string;
  /** What to do, shown over the opening countdown: a goal and the rules that decide it. */
  briefing: CampaignBriefing;
  /** The comic card; absent until a mission's art is drawn, when it starts without one. */
  card?: CampaignCard;
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
    briefing: {
      goal: "Beat the Cartel King!",
      points: [
        "Play best of three against the Cartel King.",
        "Most frags takes a three-minute round.",
        "Win two rounds to clear it.",
      ],
    },
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
    briefing: {
      goal: "Take part in the street riot!",
      points: ["You must finish as top scorer!", "The match lasts 10 minutes.", "Free for all!"],
    },
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
    briefing: {
      goal: "Plant the EMP before Monday's billing cycle!",
      points: [
        "Win 10 rounds against the Riot Police.",
        "You have 4 teammates.",
        "Plant the EMP on site A or B.",
        "(Or kill everyone in the other team!)",
      ],
    },
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
    briefing: {
      goal: "Take down the Glitch Punk Leader!",
      points: ["One on one, for 10 minutes.", "Finish with more frags than her.", "A tie goes to overtime."],
    },
    card: card(
      4,
      [
        { x: 8, y: 7, w: 684, h: 848 },
        { x: 708, y: 7, w: 821, h: 848 },
      ],
      "75% 40%",
    ),
  },
  "bot-trap": {
    title: "Bot Trap",
    hook: "Caught in the bot trap. Last five minutes.",
    rival: "Rival Cartel Bot Guards",
    briefing: {
      goal: "Survive the bot trap!",
      points: [
        "Last 5 minutes. You get one respawn: a second death ends the mission.",
        "You start with the blade and a machine gun: grab more from the map.",
        "More robots every minute, and tougher.",
        "You heal slowly while you live.",
      ],
    },
    card: card(
      5,
      [
        { x: 8, y: 8, w: 697, h: 469 },
        { x: 8, y: 487, w: 697, h: 369 },
        { x: 719, y: 8, w: 809, h: 848 },
      ],
      "74% 45%",
    ),
  },
  "siege-breaker": {
    title: "Siege Breaker",
    hook: "The final robot boss.",
    rival: "Heavy Siege Bot",
    briefing: {
      goal: "Break the Heavy Siege Bot!",
      points: [
        "Play best of three against a giant robot.",
        "It has 200 health, 200 armor and a new kit every life.",
        "Mind the slime!",
      ],
    },
    card: card(
      6,
      [
        { x: 8, y: 8, w: 751, h: 848 },
        { x: 778, y: 8, w: 749, h: 848 },
      ],
      "72% 35%",
    ),
  },
  "depot-heist": {
    title: "Depot Heist",
    hook: "A high-profile cash heist at the Depot.",
    rival: "Pink-Visor Spec-Ops and Unit 07",
    briefing: {
      goal: "Pull off the Depot cash heist!",
      points: [
        "Win 10 rounds against the spec-ops.",
        "You have 4 teammates.",
        "Plant the EMP on site A or B.",
        "(Or kill everyone in the other team!)",
      ],
    },
  },
  "road-ends": {
    title: "Road's End",
    hook: "Your road ends here.",
    rival: "Metropol Police Duo",
    briefing: {
      goal: "Your road ends here. Or theirs.",
      points: [
        "You alone against the Metropol Police duo.",
        "First to 15 frags wins.",
        "Or lead when the 10 minutes are up.",
      ],
    },
  },
};

/** The story for a mission id, or null for one this client has no art for. */
export function campaignStory(missionId: string): CampaignStory | null {
  return STORIES[missionId] ?? null;
}

/** A mission's operation number, its place in the campaign from 1; null for an unknown mission. */
export function campaignOperationNumber(missionId: string): number | null {
  const index = Object.keys(STORIES).indexOf(missionId);
  return index < 0 ? null : index + 1;
}
