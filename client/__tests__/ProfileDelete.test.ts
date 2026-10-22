// @vitest-environment jsdom

/**
 * Deleting an account from the Profile panel takes two deliberate steps: the
 * box ticked and this player's whole key pasted again. Until both are there,
 * the delete key stays off and nothing is sent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { logIn, resetAccountSessionForTests } from "../../../../lobby/AccountSession";
import { formatKey, normalizeKey } from "../../../../lobby/PlayerIdentity";
import { ProfileView } from "../ProfileView";

const KEY = "0123456789ABCDEFGHJKMNPQ";
const OTHER_KEY = "QPNMKJHGFEDCBA9876543210";

function fakeClient() {
  const handlers = new Map<string, Set<(msg: unknown) => void>>();
  const emit = (msg: { type: string }) =>
    queueMicrotask(() => {
      for (const handler of handlers.get(msg.type) ?? []) handler(msg);
    });
  return {
    connected: true,
    on(type: string, handler: (msg: unknown) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)?.add(handler);
      return () => handlers.get(type)?.delete(handler);
    },
    auth: () => emit({ type: "welcome", identity: { id: "7", name: "Tester" }, key: KEY } as never),
    rename: vi.fn(),
    deleteAccount: vi.fn((_key: string, _confirmed: boolean) => emit({ type: "identity:deleted" })),
  };
}

async function mount() {
  const client = fakeClient();
  await logIn(client as never);
  const view = new ProfileView({ client: client as never, isInRoom: () => false, modes: () => [] });
  document.body.append(view.root);
  view.open(document.body, "delete");
  const screen = [...view.root.querySelectorAll<HTMLFormElement>("form.welcome__screen")].find((form) => !form.hidden)!;
  return {
    client,
    screen,
    box: screen.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
    key: screen.querySelector<HTMLInputElement>("#profile-delete-key")!,
    go: screen.querySelector<HTMLButtonElement>('button[type="submit"]')!,
    say: () => screen.querySelector("#profile-delete-key-say")?.textContent ?? "",
  };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  resetAccountSessionForTests();
});

describe("deleting the account", () => {
  it("stays off until the box is ticked and this player's whole key is pasted", async () => {
    const { box, key, go, say } = await mount();
    expect(go.disabled).toBe(true);
    type(key, formatKey(KEY));
    expect(go.disabled).toBe(true);
    box.click();
    expect(go.disabled).toBe(false);

    type(key, formatKey(OTHER_KEY));
    expect(go.disabled).toBe(true);
    expect(say()).toBe("That isn't this player's key.");
    type(key, KEY.slice(0, 20));
    expect(go.disabled).toBe(true);
  });

  it("sends the pasted key with the box ticked, then forgets the key here", async () => {
    const { client, box, key, screen, say } = await mount();
    // The page reloads a moment after; keep that from happening here
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    box.click();
    type(key, formatKey(KEY));
    screen.requestSubmit();
    await vi.waitFor(() => expect(say()).toContain("Your account is deleted"));
    const [sentKey, confirmed] = client.deleteAccount.mock.calls[0];
    expect(normalizeKey(sentKey)).toBe(KEY);
    expect(confirmed).toBe(true);
    expect(localStorage.getItem("shag_player_key")).toBeNull();
    vi.useRealTimers();
  });
});
