/**
 * Whether this build runs on a host we don't own, and which one.
 *
 * Set at build time by `VITE_HOSTED` (`.env.itch`). A hosted build picks its
 * region in the client, loads data from that region's host and keeps the key
 * out of browser storage (StartHosted). The rest of the code asks those
 * questions, not "is this itch".
 */
export const HOSTED_ON: string | null = import.meta.env.VITE_HOSTED || null;
