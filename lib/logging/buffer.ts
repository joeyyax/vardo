// Viewer buffer: scrollback trimming, older-page merging and the history URL.

export type BufferLine = { text: string };

/** Scrollback depths offered in the viewer. */
export const SCROLLBACK_OPTIONS = [500, 2000, 10000] as const;

export const DEFAULT_SCROLLBACK = 2000;

/** Drop the oldest lines past `limit`. */
export function capLines<T>(lines: T[], limit: number): T[] {
  return lines.length > limit ? lines.slice(-limit) : lines;
}

/** Prepend an older page, dropping the overlap with what's already held. */
export function mergeOlder<T extends BufferLine>(older: T[], existing: T[]): T[] {
  if (existing.length === 0) return older;
  if (older.length === 0) return existing;

  const probe = existing.slice(0, Math.min(5, existing.length)).map((l) => l.text);
  for (let i = older.length - probe.length; i >= 0; i--) {
    if (probe.every((text, j) => older[i + j].text === text)) {
      return [...older.slice(0, i), ...existing];
    }
  }
  return [...older, ...existing];
}

/** History endpoint for a log stream URL, keeping the stream's query params. */
export function historyUrlFor(streamUrl: string, params: Record<string, string> = {}): string {
  const [path, query] = streamUrl.split("?");
  const search = new URLSearchParams(query);
  for (const [key, value] of Object.entries(params)) search.set(key, value);
  const suffix = search.toString();
  return path.replace(/\/stream$/, "") + (suffix ? `?${suffix}` : "");
}
