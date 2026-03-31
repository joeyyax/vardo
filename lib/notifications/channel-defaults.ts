import type { BusEventType } from "@/lib/bus";

/**
 * Default enabled state per channel type when a user has no preference row.
 * Email is on by default (primary channel). Slack and webhook require opt-in.
 */
export const CHANNEL_TYPE_DEFAULTS: Record<string, boolean> = {
  email: true,
  slack: false,
  webhook: false,
};

/**
 * Events that always send regardless of user preferences.
 * Users cannot mute these.
 */
export const CRITICAL_EVENT_TYPES: ReadonlySet<BusEventType> = new Set([
  "deploy.failed",
  "security.file-exposed",
  "security.scan-findings",
  "system.service-down",
  "system.disk-alert",
] as BusEventType[]);
