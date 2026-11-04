/**
 * The native client's files are the store for the settings and the account
 * key; this page's local storage mirrors them (wash-fps-rust
 * docs/research/WEBVIEW_LOBBY.md, sections 7 and 8).
 *
 * - `applyNativeStorage` copies the client's snapshot into local storage,
 *   once per webview session, before anything reads it.
 * - `installStorageMirror` sends every later write of a mirrored key to the
 *   client (`storage:set`), and takes the client's own changes
 *   (`storage:changed`, after a match).
 * - `registerNativeCvars` declares the client's cvars that nothing in this
 *   page registers (the renderer's, which the Video page edits).
 *
 * Web code keeps reading and writing local storage as it always has.
 */

import { Cvar, type CvarType, type CvarValue } from "../../../../engine/core/Cvar";
import { isSyncedStorageKey } from "../../../../shared/settings/SyncedSettings";
import type { NativeBridge } from "./NativeBridge";

/** sessionStorage: the snapshot was applied in this webview session. */
const APPLIED_KEY = "washoi.native.storage_applied";

const FILE_KEYS = new Set([
  "engine_cvars",
  "shag_settings_sync",
  "shag_settings_backup",
  "shag_player_key",
  "shag_player_key_unknown",
]);

/** Whether `key` is mirrored to a native file (shagger `lobby/storage_mirror.rs`). */
export function isMirrored(key: string): boolean {
  return FILE_KEYS.has(key) || isSyncedStorageKey(key);
}

/**
 * The client's snapshot into `local`, the first time in this session only:
 * after a reload, local storage already holds the newer values. A mirrored
 * key the page has and the client lacks (an account made in this webview
 * before the mirror) goes to the client through `adopt`.
 */
export function applyNativeStorage(
  snapshot: Record<string, unknown> | undefined,
  local: Storage,
  session: Pick<Storage, "getItem" | "setItem"> | null,
  adopt: (key: string, value: string) => void = () => undefined,
): number {
  if (!snapshot) return 0;
  try {
    if (session?.getItem(APPLIED_KEY)) return 0;
  } catch {
    // Without sessionStorage every load applies it, which is still right.
  }
  let applied = 0;
  try {
    for (const key of Object.keys(local)) {
      const value = local.getItem(key);
      if (isMirrored(key) && value !== null && !(key in snapshot)) adopt(key, value);
    }
  } catch {
    // Nothing to adopt from a storage that cannot be read.
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (!isMirrored(key) || typeof value !== "string") continue;
    try {
      if (local.getItem(key) !== value) {
        local.setItem(key, value);
        applied++;
      }
    } catch {
      // A full or blocked storage keeps the page's own value.
    }
  }
  try {
    session?.setItem(APPLIED_KEY, "1");
  } catch {
    // See above.
  }
  return applied;
}

/** Mirror `local`'s writes of the shared keys to the client, and its changes back. */
export function installStorageMirror(
  bridge: NativeBridge,
  local: Storage = window.localStorage,
  proto: Storage = Storage.prototype,
): () => void {
  const setItem = proto.setItem;
  const removeItem = proto.removeItem;
  const clear = proto.clear;
  let quiet = false;
  const send = (key: string, value: string | null) => {
    if (!quiet && isMirrored(key)) bridge.post("storage:set", { key, value });
  };
  proto.setItem = function (this: Storage, key: string, value: string) {
    setItem.call(this, key, value);
    if (this === local) send(String(key), String(value));
  };
  proto.removeItem = function (this: Storage, key: string) {
    const had = this === local && this.getItem(key) !== null;
    removeItem.call(this, key);
    if (had) send(String(key), null);
  };
  proto.clear = function (this: Storage) {
    const keys = this === local ? Object.keys(this).filter(isMirrored) : [];
    clear.call(this);
    for (const key of keys) send(key, null);
  };
  const stop = bridge.on("storage:changed", (message) => {
    const entries = message.entries;
    if (!entries || typeof entries !== "object") return;
    quiet = true;
    try {
      for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
        if (!isMirrored(key)) continue;
        if (typeof value === "string") local.setItem(key, value);
        else if (value === null) local.removeItem(key);
      }
    } catch {
      // The page reloads after a match; what did not land is read from the files next session.
    } finally {
      quiet = false;
    }
  });
  return () => {
    proto.setItem = setItem;
    proto.removeItem = removeItem;
    proto.clear = clear;
    stop();
  };
}

/** One of the client's cvars, as shagger `Cvars::declarations` describes it. */
export interface NativeCvar {
  name: string;
  type: CvarType;
  default: CvarValue;
  min?: number;
  max?: number;
  description?: string;
  persist?: boolean;
  readonly?: boolean;
  cheat?: boolean;
  hidden?: boolean;
}

/** Register the client's cvars this page does not; returns how many. */
export function registerNativeCvars(declarations: unknown): number {
  if (!Array.isArray(declarations)) return 0;
  let added = 0;
  for (const d of declarations as NativeCvar[]) {
    if (!d || typeof d.name !== "string" || Cvar.isRegistered(d.name)) continue;
    if (!["bool", "int", "float", "string"].includes(d.type)) continue;
    if (!["boolean", "number", "string"].includes(typeof d.default)) continue;
    Cvar.register(d.name, d.default, {
      type: d.type,
      min: d.min,
      max: d.max,
      description: d.description,
      persist: d.persist,
      readonly: d.readonly,
      cheat: d.cheat,
      hidden: d.hidden,
    });
    added++;
  }
  return added;
}
