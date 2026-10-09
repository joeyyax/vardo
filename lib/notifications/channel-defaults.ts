import type { BusEventType } from "@/lib/bus";

/** Default enabled state per channel type when a user has no preference row. */
export const CHANNEL_TYPE_DEFAULTS: Record<string, boolean> = {
  email: true,
  slack: false,
  webhook: false,
};

/** Events that always send, regardless of preferences. */
export const CRITICAL_EVENT_TYPES: ReadonlySet<BusEventType> = new Set([
  "deploy.failed",
  "security.file-exposed",
  "security.scan-findings",
  "system.service-down",
  "system.disk-alert",
  "system.update-failed",
  "system.recovered-unclean",
  "system.containers-missing",
] as BusEventType[]);
