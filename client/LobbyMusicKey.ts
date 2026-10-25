/**
 * The lobby music key: a speaker in the Play page's links bar that silences
 * the menus' music, and only that. It stays pressed down while the music is
 * off, and the choice is kept in browser storage.
 */

import { AudioManager } from "../../../engine/AudioManager";
import { MENU_PLAYLIST } from "../../../engine/audio/MenuPlaylist";

export const LOBBY_MUSIC_PREFERENCE = "washoi.lobby.musicMuted";

const SPEAKER =
  '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>' +
  '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
const SPEAKER_MUTED =
  '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>' +
  '<path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';

/** Whether the player turned the lobby music off. */
export function lobbyMusicMuted(): boolean {
  try {
    return localStorage.getItem(LOBBY_MUSIC_PREFERENCE) === "true";
  } catch {
    return false;
  }
}

/** Mute or unmute the menus' music, and remember it. */
export function setLobbyMusicMuted(muted: boolean): void {
  AudioManager.getInstance().setPlaylistMuted(MENU_PLAYLIST, muted);
  try {
    if (muted) localStorage.setItem(LOBBY_MUSIC_PREFERENCE, "true");
    else localStorage.removeItem(LOBBY_MUSIC_PREFERENCE);
  } catch {
    // The key still works for this visit when browser storage is unavailable.
  }
}

/** The key, showing the stored choice, which it also applies to the music. */
export function createLobbyMusicKey(): HTMLButtonElement {
  const key = document.createElement("button");
  key.type = "button";
  key.className = "lobby-credits-key lobby-music-key";
  const render = (muted: boolean) => {
    key.setAttribute("aria-pressed", String(muted));
    key.setAttribute("aria-label", "Lobby music off");
    key.title = muted ? "Lobby music is off" : "Turn the lobby music off";
    key.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${muted ? SPEAKER_MUTED : SPEAKER}</svg>`;
  };
  const muted = lobbyMusicMuted();
  AudioManager.getInstance().setPlaylistMuted(MENU_PLAYLIST, muted);
  render(muted);
  key.addEventListener("click", () => {
    const next = key.getAttribute("aria-pressed") !== "true";
    setLobbyMusicMuted(next);
    render(next);
  });
  return key;
}
