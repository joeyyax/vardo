// Stream configuration, tunable via system settings.

const DEFAULT_MAX_LEN = 10_000;
const CACHE_TTL_MS = 60_000;

let cachedMaxLen: number | null = null;
let cachedAt = 0;

/** Max stream length (XTRIM MAXLEN ~) from system settings, cached. Falls back to DEFAULT_MAX_LEN. */
export async function getStreamMaxLen(): Promise<number> {
  if (cachedMaxLen != null && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedMaxLen;
  }

  try {
    const { getSystemSettingRaw } = await import("@/lib/system-settings");
    const val = await getSystemSettingRaw("streamMaxLen");
    cachedMaxLen = val ? Number(val) : DEFAULT_MAX_LEN;
  } catch {
    cachedMaxLen = DEFAULT_MAX_LEN;
  }

  cachedAt = Date.now();
  return cachedMaxLen;
}

/** Resets the cached value after the setting changes. */
export function resetStreamConfig(): void {
  cachedMaxLen = null;
  cachedAt = 0;
}
