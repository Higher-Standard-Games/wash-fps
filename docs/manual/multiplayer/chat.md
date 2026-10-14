# In-Game Chat

Talk to the other players mid-match, without leaving the fight.

## How to Chat

- Press **T** to open the chat input. This is *talk mode*.
- Press **Y** for **team chat**. The prompt reads **TEAM**; messages are marked
  **[TEAM]** and delivered only to players on your side, including you.
- Type your message and press **Enter** to send.
- Press **Esc** to cancel without sending.

While composing text with an input method, Enter and Escape belong to the input
method; confirm the text first, then press Enter to send.

While the input is open, **your mouse look keeps working** and the pointer stays locked — you don't drop out of the game. Your movement keys type letters instead of moving you (WASD becomes text), so you stand still while typing. Any key held when you open chat is released cleanly (no stuck-forward).

Chat is disabled while the match menu, settings, or console is open, so **T** there does nothing special.

Team chat requires a team seat. Spectators cannot send or receive it. In FFA it
is unavailable; the game tells you rather than sending the message globally.
You can also type `/say_team <message>` in chat, or `say_team <message>` in the
console. Global and team chat share the same message length and rate limits.

## Muting for this match

Type `/mute <playername>` in chat to ignore that full name, without case
sensitivity. `/unmute <playername>` removes it. These commands run locally and
are not sent to other players. They show a confirmation or usage hint in your log.

Muting hides that player's existing chat lines and ignores future global/team
messages, including their spectator messages. System notices and kill-feed events
remain visible. Unmuting restores future messages; ignored messages are not
replayed. Nothing is saved: leaving the match, or the next match's warmup on a
continuous server, clears the ignore list. This lightweight filter is name-based;
if a player changes their name, mute the new name too.

## Reading Chat

- **Closed:** the last few messages float over the bottom-left of the screen and fade out after ~8 seconds.
- **Talk mode:** opening chat expands the log into a **scrollable history dialog** showing the latest 100 messages. Mouse-wheel to scroll back through it; new messages follow automatically only when you are near the bottom. The oldest messages drop out as the history fills. Closing collapses back to the fading overlay.

Sender names are colour-stamped by allegiance rather than by side: teammates in one colour, opponents in the other, whichever side you are on this half. Spectators are greyed.

Lines from the game rather than a player — why a join was refused, your place in the challengers queue, a round to wait for — have no name and are written in gold.

## Rules

- Messages are limited to **128 characters**.
- There's a light rate limit (roughly one message per 0.6s, with a short-burst cap) to stop spam. Over-limit messages are quietly dropped.
- The server sanitizes and re-broadcasts every message, so what you see is authoritative. There is no local echo — your own message appears when the server sends it back (one snapshot later, effectively instant).

## Chat in Demos

Chat is **recorded into server demos automatically**, including both teams'
messages, and replays at the moment it was sent. Team routing protects live play;
the server recording contains the whole match. Your local mute list does not
alter the recording.


## See Also

- [Connecting](./connecting.md) — joining a server
- [Demos](./demos.md) — recording and replaying matches (chat included)
- [HUD](../player/hud.md) — where chat sits on screen
