# Training Bots From Demos

The point of this pipeline is bots that move like people. A recorded match is a
record of what a person did; training reads those recordings and fits networks
that the [bot server](./bot-server.md) then hands to its bots, where they sit on
top of the rule-based brain rather than replacing it.

The chain, end to end:

```
match → .shagdemo → corpus → labels → fit → weights + metadata → a bot in a room
```

Nothing in it is automatic. A match records itself, but building a corpus and
training from it are commands you run.

## What a recording holds

A game server starts recording when the match phase goes Active and stops at
post-game — no flag, no console command. Files land in `public/data/demos/`
relative to the server's working directory, named
`map_gametype_YYYYMMDD_HHmmss.shagdemo`, and a match shorter than ten seconds is
discarded rather than saved.

Format version 3 records two things per frame: the snapshot, and **the commands
the server applied**. The commands are what make a demo trainable. Without them,
training has to work out which buttons produced the motion it can see, and that
guess is wrong exactly where this game is most itself: in an air-strafe the wish
direction and the velocity point different ways on purpose. Commands arrive at
tick rate while frames are written at snapshot rate, so several fold into one
record — buttons are OR-ed together, so a press between two snapshots is not
lost, and the analogue fields keep the value they ended on.

A frame with no command is not a gap in the data. It means the player sent
nothing over that interval, which is to say they pressed nothing.

## Who counts as a person

A roster entry carries an `accountId` only when that seat was taken with a
verified lobby ticket. Bots have none. Training keeps the verified players and
drops everything else, because a network trained on bot play learns the state
machine it exists to grow beyond.

Pass `--include-bots` to train on every player in the recording. That is for
self-play datasets, where the bot's own behaviour is the point.

## Building a corpus

Point `--demo` at a file or at a directory. A directory is read as one corpus:

```bash
npx vite-node src/cli/bot-train.ts -- --demo public/data/demos --epochs 50
```

- Matches already counted are skipped by match id, so re-running over a growing
  folder does not train twice on the same match.
- A recording that cannot be read, or that holds no verified player, is skipped
  with a reason. One bad file does not cost you the other forty-nine.
- **Whole matches are held back for validation, never single frames.** Frames
  seconds apart in one match are nearly the same frame, so a frame-level split
  reports a score measured on play the network has effectively already seen. With
  a single match there is nothing to hold back, and the run says so: the loss
  then tells you the frames were memorised, not that anything was learned.

Scale, so you know what you are looking at: a three-minute duel yields roughly
ten thousand frames per player. Behaviour cloning wants on the order of a hundred
thousand. One match is a smoke test; a folder of fifty is a training set.

## What the network is asked

The labels are what the person did — not how well the frame went. Reward is the
right signal for sharpening a bot against itself later; it is not an answer to
"what would a person do here", and using it as one meant that on a neutral
frame, which is most frames, every target said 0.5 whatever the player had done.

Every output exists because a demo can answer it:

| Head | Output | Comes from |
|------|--------|-----------|
| Tactical | sprint, slide, jump | the buttons held |
| Tactical | switch | whether the slot changed since the previous frame |
| Tactical | slot | the commanded slot, over nine |
| Combat | fire, alt-fire | the buttons held |
| Combat | aim yaw, aim pitch | **the turn made between two frames** |
| Combat | dodge left, dodge right | the wish direction given, not the velocity |

Aim is the part worth having: view angles are recorded state, so the turn a
person made is the one label here that was never a guess.

Because aim and weapon labels are *differences*, they are only built inside a
**run** — one player, one match, in order. Two runs are never adjacent, and two
frames within a run must also be close in time: a player who is dead or absent
is skipped, so the array can jump from a death to a respawn hundreds of ticks
later. A turn measured across that jump is a flick made while staring at a
respawn screen. Frames further apart than a dozen ticks are treated as having no
predecessor, which costs one label and invents none.

Frames whose features are the wrong width, or hold a value that is not a number,
are dropped and counted in the run's output. A single NaN in a training tensor
turns the loss to NaN and takes the weights with it.

## What the network sees

Not one frame but the last three, oldest first. A single frame is a still:
whether a player is starting a strafe-jump or finishing one, closing on an item
or leaving it, is invisible in one vector and plain in three. The same gap rule
applies — a stack never reaches back across a death — and until three frames
exist, the oldest one there stands in for the rest, which reads as "nothing was
changing" rather than as the dead, unarmed, motionless player that zeros would
describe.

Every vector is built by one piece of code, used by the demo extractor, by the
self-play recorder and by the bot in a match. That is the promise a trained model
depends on: the vector it is fed in a match was built exactly the way the
vectors it learned from were. Training therefore reads each demo **with its
map** — the same line of sight and item distances a bot on that map would have —
and gives every player their own view of it, as each bot has. A map that will
not load is reported, and its matches are read blind, the way a bot with no map
would play them.

Stacks are one snapshot apart on both sides, because a demo writes a frame per
snapshot and a bot decides per snapshot it receives. Train on recordings from a
server running the same snapshot rate as the one the bots will play on.

## Training and what it leaves behind

```bash
# One directory as a corpus, fifty passes over it
npx vite-node src/cli/bot-train.ts -- --demo public/data/demos --epochs 50

# Somewhere else for the weights
npx vite-node src/cli/bot-train.ts -- --demo public/data/demos --models ./models/human

# Continue from weights that already exist
npx vite-node src/cli/bot-train.ts -- --demo public/data/demos --resume
```

Useful flags: `--epochs`, `--batch`, `--lr`, `--models`, `--resume`,
`--include-bots`, `--patience`. Weights default to `./src/games/fps/models`.

Beside the weights the run writes `metadata.json`: the feature widths and output
widths they were trained against, when, how many matches and frames, whether bots
were included, and the match ids. This is what stops a silent mismatch — a dense
layer accepts any vector of the right length, so a changed feature vector would
otherwise load happily and read noise. Weights whose widths disagree with the
build are refused at load with a reason. Weights with no metadata beside them
load, with a warning that their shape is unknown.

The loss printed at the end is followed by a held-out figure whenever the corpus
had more than one match. That second number is the one that means anything, and a
run stops on its own once it has gone `--patience` epochs without improving it
(five by default; `0` runs every epoch). Stopping keeps the last epoch's weights
rather than the best ones, which TF.js gives no way to restore, so patience is
the whole of the protection.

Then each output is scored on the held-out matches against a floor:

```
[Trainer] Tactical per output (error / floor, lower is better; floor = best fixed answer):
[Trainer]   sprint     0.1832 / 0.4000  on in 40.0% of frames — learned
[Trainer]   jump       0.0904 / 0.0900  on in 9.0% of frames — no better than a fixed answer
```

The floor is the error of the best answer that ignores the input entirely. It is
there because most of these outputs are off most of the time: a network that
answers "no" to every button scores a respectable-looking error and has learned
nothing. An output whose error is not below its floor was not learned, whatever
the loss says.

## Getting the weights into a bot

```bash
npm run bot:server -- --models ./models/human
```

The bot server passes its model directory to every bot it creates, including
bots a player adds from a room — the lobby sends only a difficulty, so without a
default on the server those bots would run the plain state machine however much
had been trained. A specific request can name its own directory instead.

A bot takes its difficulty's own weights when the directory has a subdirectory
for it — self-play leaves one per tier, `easy/` to `insane/` — and the weights in
the directory itself otherwise, which is where demo training puts them.

To watch trained weights play before anyone plays against them, record a match
of bots using them:

```bash
npm run demo:record -- --map wdm12 --bots 2 --seconds 120 --models ./models/human
```

Its recordings hold no verified players, so training reads them only with
`--include-bots`. Keep bot matches long, or the map small: two bots on a large map
can spend a minute collecting items without meeting, and a match with no fight in
it gives the combat head nothing to learn.

Loading is per bot and failure is soft: a bot whose models will not load plays
the rules, which is the floor this whole system builds on rather than a fallback
to apologise for.

## Self-play

`bot:train` without `--demo` runs the live loop instead: spawn bots against each
other on a running server, record episodes, train, repeat.

```bash
npm run net:server -- --port 17777 --map wdm7
npx vite-node src/cli/bot-train.ts -- --map wdm7 --rounds 100
```

It builds the same labels through the same code as the demo path, so an output
cannot come to mean one thing here and another when cloning a person. Reward
enters as a sample weight: the best frames of a round pull hardest, the worst
pull not at all. Each bot's episode is its own run.

Self-play sharpens; it cannot teach the network to move like a person, because
there is no person in it. Demos are where that comes from.

## What it costs

`npm run bot:bench` measures the neural overlay on a synthetic fight state — the
difference the network makes to a decision, without the vision and navigation a
real map adds, since those are the state machine's cost either way.

On a native backend with eight bots, the network adds about **half a millisecond
per decision**, and the weights themselves are a few kilobytes per bot. A bot
decides when a snapshot arrives, not every tick — the 125 Hz input loop re-sends
the last decision — so eight bots cost around 4 ms per snapshot interval, all of
it on one thread, because the whole fleet lives in one process. That is 8% of a
20 Hz interval and 25% of a 60 Hz one.

Run it yourself before assuming any of those numbers apply to your machine:

```bash
npm run bot:bench -- --bots 8 --decisions 2000
```

## Not yet

- Aim is squeezed through a sigmoid with 0.5 meaning "no turn", which is the
  existing head's shape rather than a good one for a signed quantity.
- Nothing checks that the snapshot rate the bots play at matches the one the
  training demos were recorded at, which is what makes a stack of three frames
  mean the same stretch of time on both sides.
- Every bot runs its own `predict` call. The measured cost per decision is
  dominated by that round trip rather than by the arithmetic, so batching the
  fleet into one call is worth nearly all of it.

Progress and reasoning for all of it: `docs/research/BOT_TF_IMPROVEMENTS.md` in
the engine repo.
