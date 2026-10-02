# In-Game Chat

Talk to the other players mid-match, without leaving the fight.

## How to Chat

- Press **T** to open the chat input. This is *talk mode*.
- Type your message and press **Enter** to send.
- Press **Esc** to cancel without sending.

While the input is open, **your mouse look keeps working** and the pointer stays locked — you don't drop out of the game. Your movement keys type letters instead of moving you (WASD becomes text), so you stand still while typing. Any key held when you open chat is released cleanly (no stuck-forward).

Chat is disabled while the match menu, settings, or console is open, so **T** there does nothing special.

## Reading Chat

- **Closed:** the last few messages float over the bottom-left of the screen and fade out after ~8 seconds.
- **Talk mode:** opening chat expands the log into a **scrollable history dialog** showing everything from the match. Mouse-wheel to scroll back through it. Closing collapses back to the fading overlay.

Sender names are colour-stamped by allegiance rather than by side: teammates in one colour, opponents in the other, whichever side you are on this half. Spectators are greyed.

Lines from the game rather than a player — why a join was refused, your place in the challengers queue, a round to wait for — have no name and are written in gold.

## Rules

- Messages are limited to **128 characters**.
- There's a light rate limit (roughly one message per 0.6s, with a short-burst cap) to stop spam. Over-limit messages are quietly dropped.
- The server sanitizes and re-broadcasts every message, so what you see is authoritative. There is no local echo — your own message appears when the server sends it back (one snapshot later, effectively instant).

## Chat in Demos

Chat is **recorded into demos automatically** and replays at the exact moment it was sent. Watching a demo, you'll see the match chatter play back in the same history dialog. This is handy for reviewing calls and banter in recorded matches.

::: tip Coming later
Team-only chat (say_team / **Y**), mute/ignore, and chat commands are planned follow-ups.
:::

## See Also

- [Connecting](./connecting.md) — joining a server
- [Demos](./demos.md) — recording and replaying matches (chat included)
- [HUD](../player/hud.md) — where chat sits on screen
