// ---------------------------------------------------------------------------
// Stream configuration — admin-tunable via system settings
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LEN = 10_000;
const CACHE_TTL_MS = 60_000; // Re-read setting every 60s

let cachedMaxLen: number | null = null;
let cachedAt = 0;

/**
 * Get the max stream length (XTRIM MAXLEN ~).
 * Reads from system settings and caches for CACHE_TTL_MS.
 * Falls back to DEFAULT_MAX_LEN if settings aren't available.
 */
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

/** Reset the cached value (e.g. after admin changes the setting). */
export function resetStreamConfig(): void {
  cachedMaxLen = null;
  cachedAt = 0;
}
