/**
 * Mask sensitive fields in a notification channel's config before returning to clients.
 */
export function maskChannelConfig<T extends { type: string; config: unknown }>(
  channel: T,
): T {
  const config = channel.config as Record<string, unknown> | null;
  if (!config) return channel;

  if (channel.type === "webhook" && typeof config.secret === "string") {
    const s = config.secret;
    return {
      ...channel,
      config: { ...config, secret: s.length > 4 ? `****${s.slice(-4)}` : "****" },
    };
  }

  if (channel.type === "slack" && typeof config.webhookUrl === "string") {
    return {
      ...channel,
      config: { ...config, webhookUrl: "****" },
    };
  }

  return channel;
}
