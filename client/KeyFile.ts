import { formatKey } from "../../../lobby/PlayerIdentity";

const KEY_FILE_LINES = (name: string, key: string) => [
  "Washiki Washoi player key",
  "",
  `Player: ${name}`,
  `Key:    ${key}`,
  "",
  'To play as this player in another browser, open the game, choose "Use my key"',
  "and paste the key. Anyone with this key can play as you. Keep it private.",
  "",
];

/** Download the player's key as a text file, named for the player. */
export function saveKeyFile(name: string, key: string): void {
  const blob = new Blob([KEY_FILE_LINES(name, formatKey(key)).join("\n")], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `washoi-key-${name}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
