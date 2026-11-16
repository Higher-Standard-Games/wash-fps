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
  /** The story so far, under the title on the Campaign page. */
  intro: string;
  /** One line of story, on the briefing over the opening countdown. */
  line: string;
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
    intro:
      "So you want a Cartel contract? Cute. First, survive three rounds in Washoi Amphi2 against a Cartel King with zero trigger discipline, limited-edition sneakers, and an ego tied directly to live crypto margins.",
    line: "Prove your slide-speed to the Cartel—and don't bleed on the boss's sneakers.",
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
    intro:
      "Congratulations, the Cartel didn't scrap you. Your orientation bonus? Getting dropped straight into a Sector 1 free-for-all swarming with over-caffeinated Glitch Punks and trigger-happy cops. Stay airborne and hoard the armor bubbles.",
    line: "Treat gravity like a suggestion and out-frag a Sector 1 riot.",
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
    intro:
      "Time to earn your retainer. The Cartel wants OmniSec's traffic-fine servers vaporized before Monday's billing cycle. Plant the EMP charge at Concrete Strike—just watch out for Metropol Riot Cops running double overtime shifts and treating excessive force like morning cardio.",
    line: "Plant the EMP, wipe the Cartel's parking tickets, and ruin Monday morning.",
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
    intro:
      "Plot twist: blowing up OmniSec's servers also fried the Glitch Punks' pirate Wi-Fi. Now their neon-haired boss wants your head in a 1v1 turf duel on Washoi DM2. Cut her off at the Mega Health before she rockets her way across the map.",
    line: "You fried their pirate Wi-Fi—now survive the Glitch Punk boss's rockets.",
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
    intro:
      'A "100% reliable" Cartel tip led you straight into a rigged rival vault. With the exit shutters welded shut and three floors of warranty-voided security bots dropping from the rafters, there\'s only one way out: survive the swarm until the locks blow.',
    line: "Three floors of warranty-voided scrap-bots and zero exit codes.",
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
    intro:
      "Word of your vault breakout spread fast—and a rogue Spec-Ops handler just unclamped a giant Unit 07 Siege Bot to see how long you last. Crouch-slide beneath its rotary fire in Washoi Amphi1 and turn this expired war machine into scrap.",
    line: "Crouch-slide the rotary miniguns and scrap a giant war titan.",
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
    intro:
      "Your titan-scrapping highlight reel made you famous—and one final sabotage gig at OmniSec's freight depot pays enough for a skyline penthouse. Only problem? That same rogue Spec-Ops merc and a freshly updated Unit 07 took the defense contract to pay off their monthly firewall bills.",
    line: "Breach the freight yard before Unit 07's antivirus auto-renews.",
    rival: "Rogue Spec-Ops and Unit 07",
    briefing: {
      goal: "Pull off the Depot cash heist!",
      points: [
        "Win 10 rounds against the spec-ops.",
        "You have 4 teammates.",
        "Plant the EMP on site A or B.",
        "(Or kill everyone in the other team!)",
      ],
    },
    card: card(
      7,
      [
        { x: 7, y: 7, w: 877, h: 476 },
        { x: 7, y: 493, w: 877, h: 365 },
        { x: 896, y: 7, w: 633, h: 850 },
      ],
      "78% 55%",
    ),
  },
  "road-ends": {
    title: "Road's End",
    intro:
      "It's a setup. That depot payload wasn't cash—it was a live OmniSec tracking beacon. Now Washoi DM5 is sealed under championship lockdown, and Metropol's top Male and Female riot enforcers have synchronized their HUDs for a regulatory two-on-one execution. Break the blockade and take the crown.",
    line: "Two badges, double overtime, and zero mercy—break the blockade.",
    rival: "Metropol Police Duo",
    briefing: {
      goal: "Your road ends here. Or theirs.",
      points: [
        "You alone against the Metropol Police duo.",
        "A full 10-minute match.",
        "Lead when the time is up to win.",
      ],
    },
    card: card(
      8,
      [
        { x: 6, y: 6, w: 756, h: 853 },
        { x: 772, y: 6, w: 758, h: 853 },
      ],
      "72% 45%",
    ),
  },
};

/** The card for a finished campaign, under the last operation once every one is cleared. */
export const FINALE_CARD: CampaignCard = {
  image: "/images/campaign/card9.webp",
  thumb: "/images/campaign/card9-thumb.webp",
  width: 2752,
  height: 1536,
  panels: [
    { x: 11, y: 5, w: 1354, h: 1527 },
    { x: 1385, y: 5, w: 1357, h: 1527 },
  ],
  thumbFocus: "72% 45%",
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
