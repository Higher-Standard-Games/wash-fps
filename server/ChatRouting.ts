import type { ChatSnapshotEvent } from "../../../engine/network/core/SnapshotEvent";

/** Server-only addressing metadata; the existing chat wire format stays unchanged. */
export type ScopedChatEvent = ChatSnapshotEvent & { recipientIds?: readonly string[] };
export type PendingChatEvent = Omit<ScopedChatEvent, "type">;

export function chatVisibleTo(event: { type: string; recipientIds?: readonly string[] }, recipientId: string): boolean {
  if (event.type !== "chat") return true;
  const recipients = event.recipientIds;
  return recipients === undefined || recipients.includes(recipientId);
}
