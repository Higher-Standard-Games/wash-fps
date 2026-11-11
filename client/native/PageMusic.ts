/**
 * PageMusic — the lobby page stays loaded, hidden, while the native client
 * plays a match or a recording, and its menu music would play on under the
 * client's own. This silences the page's music for that time.
 */

import { AudioManager } from "../../../../engine/AudioManager";

/** Stops the page's music now; the returned call lets it play again as it was. */
export function silencePageMusic(): () => void {
  const audio = AudioManager.getInstance();
  const was = audio.isMusicEnabled();
  audio.setMusicEnabled(false);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    audio.setMusicEnabled(was);
  };
}
