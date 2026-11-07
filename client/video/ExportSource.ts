export interface ExportSource {
  url?: string;
  bytes?: Uint8Array;
  label: string;
  durationMs: number;
  filename: string;
}

/** Only data crosses the document boundary; playback objects remain with their owner. */
export function isExportSource(value: unknown): value is ExportSource {
  if (!value || typeof value !== "object") return false;
  const source = value as ExportSource;
  if (
    typeof source.label !== "string" ||
    typeof source.filename !== "string" ||
    !Number.isFinite(source.durationMs) ||
    source.durationMs < 0
  )
    return false;
  if (source.bytes instanceof Uint8Array) return !source.url;
  if (typeof source.url !== "string") return false;
  try {
    return ["https:", "http:"].includes(new URL(source.url, location.origin).protocol);
  } catch {
    return false;
  }
}
