export const CHANNEL_TYPES = ["email", "webhook", "slack", "ntfy", "discord", "telegram", "pushover"] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];
