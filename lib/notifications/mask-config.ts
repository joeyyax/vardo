const MASK = "****";
const URL_FIELD: Record<string, string> = { webhook: "url", slack: "webhookUrl" };

/** Masks sensitive fields in a channel's config before returning it to clients. */
export function maskChannelConfig<T extends { type: string; config: unknown }>(
  channel: T,
): T {
  const config = channel.config as Record<string, unknown> | null;
  if (!config) return channel;

  const masked = { ...config };
  if (channel.type === "webhook" && typeof masked.secret === "string") {
    const s = masked.secret;
    masked.secret = s.length > 4 ? `${MASK}${s.slice(-4)}` : MASK;
  }

  const urlField = URL_FIELD[channel.type];
  if (urlField && typeof masked[urlField] === "string" && masked[urlField]) masked[urlField] = MASK;

  return { ...channel, config: masked };
}

/** Whether a client sent a masked placeholder back instead of a new value. */
export function isMaskedValue(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(MASK);
}

/** Keeps the stored URL and secret wherever the incoming config still holds a mask. */
export function restoreMaskedConfig(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | null,
): Record<string, unknown> {
  const out = { ...incoming };
  for (const key of ["url", "webhookUrl", "secret"]) {
    if (!isMaskedValue(out[key])) continue;
    if (typeof stored?.[key] === "string") out[key] = stored[key];
    else delete out[key];
  }
  return out;
}
