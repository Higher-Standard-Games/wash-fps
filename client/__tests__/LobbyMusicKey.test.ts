// @vitest-environment jsdom
/**
 * The lobby music key mutes the menus' music only, stays pressed while it is
 * off, and keeps the choice in browser storage.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioManager } from "../../../../engine/AudioManager";
import { MENU_PLAYLIST } from "../../../../engine/audio/MenuPlaylist";
import { createLobbyMusicKey, LOBBY_MUSIC_PREFERENCE } from "../LobbyMusicKey";

beforeEach(() => {
  localStorage.clear();
  AudioManager.resetInstance();
});

afterEach(() => {
  localStorage.clear();
  AudioManager.resetInstance();
});

describe("lobby music key", () => {
  it("toggles the menu playlist's mute, the pressed state and the stored choice", () => {
    const key = createLobbyMusicKey();
    const audio = AudioManager.getInstance();
    expect(key.getAttribute("aria-pressed")).toBe("false");
    expect(audio.isPlaylistMuted(MENU_PLAYLIST)).toBe(false);

    key.click();
    expect(key.getAttribute("aria-pressed")).toBe("true");
    expect(audio.isPlaylistMuted(MENU_PLAYLIST)).toBe(true);
    expect(audio.isPlaylistMuted("data/game.playlist.json")).toBe(false);
    expect(localStorage.getItem(LOBBY_MUSIC_PREFERENCE)).toBe("true");

    key.click();
    expect(key.getAttribute("aria-pressed")).toBe("false");
    expect(audio.isPlaylistMuted(MENU_PLAYLIST)).toBe(false);
    expect(localStorage.getItem(LOBBY_MUSIC_PREFERENCE)).toBeNull();
  });

  it("starts from the stored choice", () => {
    localStorage.setItem(LOBBY_MUSIC_PREFERENCE, "true");
    const key = createLobbyMusicKey();
    expect(key.getAttribute("aria-pressed")).toBe("true");
    expect(AudioManager.getInstance().isPlaylistMuted(MENU_PLAYLIST)).toBe(true);
  });
});
