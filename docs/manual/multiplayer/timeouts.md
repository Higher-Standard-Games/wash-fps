# Timeouts

A timeout pauses the match. Everything stops where it is: players, projectiles,
item timers and the match clock. When play resumes, everything carries on
exactly as it was; a player who was falling keeps falling at the same speed.

Timeouts are available in **Duel**, **Amphi** and **Search & Destroy**. Free-for-all
has none.

## Calling a timeout

Type `/timeout` in chat, or `timeout` in the console.

- Every player gets **one timeout per match**. Spectators cannot call one.
- It can be called while the match is being played, including during a
  round's result, but not in warmup, the countdown before the match or the
  freeze at the start of a round.
- A timeout lasts up to **two minutes**.

While the match is paused you can look around and chat, but you cannot move,
shoot or use anything. The screen shows **Timeout**, who called it and the time
left, and the announcer calls "timeout".

## Time in

Any player can end a timeout: type `/timein` in chat, or `timein` in the
console. The announcer calls "time in" and the match counts back in for three
seconds before play resumes, so it never starts abruptly. A timeout that is not
ended runs out after two minutes and counts back in the same way.

A timeout called during the count back in pauses the match again, if the player
calling it still has theirs.

## When a player drops

In Duel and Amphi, a player whose connection drops in a live match pauses it
straight away. This timeout is the server's, so it costs nobody theirs, and the
screen says who dropped.

- The dropped player's seat is held for the whole timeout. Coming back puts them
  back in the same seat with their score; the match stays paused until someone
  calls time in.
- If the timeout runs out with the player still away, they forfeit when play
  resumes, and their opponent wins.
- If a player calls time in before the dropped player is back, play resumes and
  the seat is held for the rest of the usual 60 seconds.

In Search & Destroy a drop does not pause the match; the seat is held for 60
seconds, and a player may still call a timeout for their team.

## Demos

A recording leaves the pause out: playback goes straight from the moment the
timeout was called to the moment play resumed. Chat sent during the pause is not
recorded.
