/**
 * What bots say in chat, by moment. `{name}` is the human the line is about.
 *
 * English, with the odd Finnish line slipped in as a joke (marked `// fi`).
 * Every line fits the server's 128-character chat cap.
 */

export type ChatMoment = "greet" | "killedHuman" | "bladeKill" | "streak" | "gracious" | "mad" | "sulk" | "gg";

export const BOT_CHAT_LINES: Record<ChatMoment, readonly string[]> = {
  greet: [
    "gl hf!",
    "glhf everyone",
    "Good luck, have fun!",
    "hf all, be gentle",
    "gl hf, may your rockets fly true",
    "hi {name}! glhf",
    "Stretching my aim arm. glhf",
    "Ready when you are. gl hf",
    "glhf, I just had noodles so I'm fast",
    "Let's have a good one! glhf",
    "o/ gl hf",
    "Hello! Please don't rail me first. glhf",
    "Onnea ja hauskaa peliä!", // fi
    "Moi! gl hf", // fi
    "glhf, no camping (I'm lying, I camp)",
  ],
  killedHuman: [
    "gotcha {name}",
    "Sorry {name}, nothing personal",
    "Was that your face or my rocket?",
    "{name}, you dropped this: 1 frag",
    "Too slow!",
    "Peekaboo",
    "Next time, {name}",
    "Did you hear me coming? :)",
    "Thanks for the frag {name}",
    "That one felt nice",
    "Hehe",
    "I'd say sorry but I'm not",
    "Respawn and try again, {name}",
    "Ei ollu ees vaikee", // fi: "wasn't even hard"
    "Kiitos {name}!", // fi: "thanks"
  ],
  bladeKill: [
    "Sliced!",
    "Blade check, {name}",
    "Who needs guns anyway",
    "Slide. Slash. Done.",
    "Got sashimi'd, {name}",
    "Knife to meet you",
    "That's the sharp end",
    "Look ma, no bullets",
    "Should've kept your distance, {name}",
    "Fresh cut, {name}",
    "Melee is a lifestyle",
    "Shhhk!",
    "Too close for comfort, {name}?",
    "Puukko!", // fi: Finnish knife
    "Tuli kylmä rauta, {name}", // fi: "cold steel came"
  ],
  streak: [
    "I'm on fire!",
    "Can't stop me now",
    "Who's next?",
    "Is anyone else even playing?",
    "Streak! Somebody stop me",
    "Feeling dangerous today",
    "Unstoppable noodle",
    "One more, come on",
    "My aim is warm now",
    "Rampage!",
    "This is my map",
    "Counting frags is hard when there are so many",
    "Getting too easy, {name}",
    "Nyt lähti!", // fi: "now it's going!"
    "Mä oon liekeissä!", // fi: "I'm on fire"
  ],
  gracious: [
    "nice shot {name}",
    "ns",
    "Good one, {name}",
    "Well played",
    "Okay, that was clean",
    "Didn't see that coming",
    "wp {name}",
    "Fair enough",
    "Respect, {name}",
    "Nice aim!",
    "I'll get you next time",
    "Ouch, nice",
    "That was a good one",
    "Hyvä veto, {name}", // fi: "good move"
    "Hyvä!", // fi: "good"
  ],
  mad: [
    "Lucky shot, {name}",
    "Lag!",
    "My mouse slipped",
    "Was that even a hit??",
    "Ugh.",
    "I wasn't ready",
    "Spam. Pure spam.",
    "Okay now it's personal, {name}",
    "Really? From there?",
    "Hacks! (jk... unless?)",
    "I demand a rematch",
    "You'll pay for that, {name}",
    "That's it, no more Mr Nice Bot",
    "Perkele!", // fi
    "Voi että, {name}...", // fi: "oh for…"
  ],
  sulk: [
    "This is fine.",
    "I need a break",
    "Can someone check my aim settings",
    "Why does everyone shoot me",
    "Not my day",
    "Am I even playing?",
    "I'll just respawn and stand here",
    "Stop picking on me, {name}",
    "I'm only a bot, you know",
    "Rough match...",
    "Calibrating. Ignore the scoreboard.",
    "Is it over yet?",
    "My noodles are getting cold",
    "Ei mee putkeen", // fi: "nothing's going right"
    "Huono päivä", // fi: "bad day"
  ],
  gg: [
    "gg",
    "gg wp",
    "Good game!",
    "gg all",
    "gg {name}, that was fun",
    "gg, thanks for playing",
    "ggs",
    "Good game everyone",
    "gg, rematch?",
    "That was fun, gg",
    "gg wp, see you next round",
    "gg, I need a nap",
    "gg! Back to the noodle shop",
    "Hyvä peli!", // fi: "good game"
    "Kiitos pelistä!", // fi: "thanks for the game"
  ],
};
