// ---------------------------------------------------------------------------
// Stream configuration — admin-tunable via system settings
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LEN = 10_000;

let cachedMaxLen: number | null = null;

/**
 * Get the max stream length (XTRIM MAXLEN ~).
 * Reads from system settings on first call, then caches for the process lifetime.
 * Falls back to DEFAULT_MAX_LEN if settings aren't available.
 */
export async function getStreamMaxLen(): Promise<number> {
  if (cachedMaxLen != null) return cachedMaxLen;

  try {
    const { getSystemSettingRaw } = await import("@/lib/system-settings");
    const val = await getSystemSettingRaw("streamMaxLen");
    cachedMaxLen = val ? Number(val) : DEFAULT_MAX_LEN;
  } catch {
    cachedMaxLen = DEFAULT_MAX_LEN;
  }

  return cachedMaxLen;
}

/** Reset the cached value (e.g. after admin changes the setting). */
export function resetStreamConfig(): void {
  cachedMaxLen = null;
}
