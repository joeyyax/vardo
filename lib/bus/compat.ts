/**
 * Compatibility layer between legacy NotificationEvent and typed BusEvent.
 *
 * Allows the old notify() call sites to keep working while the bus uses
 * the new typed format internally.
 */

import type { NotificationEvent, NotificationEventType } from "@/lib/notifications/port";
import type { BusEvent, BusEventType } from "./events";

// ---------------------------------------------------------------------------
// Legacy type -> bus type mapping
// ---------------------------------------------------------------------------

const LEGACY_TO_BUS: Record<NotificationEventType, BusEventType> = {
  "deploy-success": "deploy.success",
  "deploy-failed": "deploy.failed",
  "auto-rollback": "deploy.rollback",
  "backup-success": "backup.success",
  "backup-failed": "backup.failed",
  "cron-failed": "cron.failed",
  "volume-drift": "volume.drift",
  "disk-write-alert": "disk.write-alert",
  "invitation-sent": "org.invitation-sent",
  "invitation-accepted": "org.invitation-accepted",
  "system-alert-service": "system.service-down",
  "system-alert-disk": "system.disk-alert",
  "system-alert-restart": "system.restart-loop",
  "system-alert-cert": "system.cert-expiring",
  "system-alert-update": "system.update-available",
  "weekly-digest": "digest.weekly",
};

const BUS_TO_LEGACY: Record<BusEventType, NotificationEventType> = Object.fromEntries(
  Object.entries(LEGACY_TO_BUS).map(([k, v]) => [v, k]),
) as Record<BusEventType, NotificationEventType>;

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

/**
 * Convert a legacy NotificationEvent to a BusEvent.
 *
 * Since the legacy format uses Record<string, string> for metadata, we
 * spread all metadata fields onto the bus event and coerce numeric strings
 * where the typed event expects a number. Title and message pass through.
 */
export function toBusEvent(event: NotificationEvent): BusEvent {
  const busType = LEGACY_TO_BUS[event.type];
  if (!busType) {
    throw new Error(`[bus/compat] Unknown legacy event type: ${event.type}`);
  }

  // Spread metadata and coerce known numeric fields
  const base = {
    type: busType,
    title: event.title,
    message: event.message,
    ...event.metadata,
  };

  // Coerce numeric fields — the legacy format stores everything as strings
  return coerceNumerics(base) as unknown as BusEvent;
}

/**
 * Convert a BusEvent back to legacy NotificationEvent format.
 *
 * Extracts title/message and flattens all other fields into metadata
 * as strings (matching the old Record<string, string> contract).
 */
export function toLegacyEvent(event: BusEvent): NotificationEvent {
  const legacyType = BUS_TO_LEGACY[event.type];
  if (!legacyType) {
    throw new Error(`[bus/compat] Unknown bus event type: ${event.type}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type: _busType, title, message, ...rest } = event;
  const metadata: Record<string, string> = {};

  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== null) {
      metadata[key] = String(value);
    }
  }

  return { type: legacyType, title, message, metadata };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fields that should be numbers in the typed bus events */
const NUMERIC_FIELDS = new Set([
  "totalCount",
  "totalSize",
  "failedCount",
  "durationMs",
  "totalDrift",
  "writtenBytes",
  "thresholdBytes",
  "percent",
  "threshold",
  "used",
  "total",
  "uptimeSeconds",
  "daysLeft",
  "deploysTotal",
  "deploysSucceeded",
  "deploysFailed",
  "backupsTotal",
  "backupsFailed",
  "cronTotal",
  "cronFailed",
]);

function coerceNumerics(obj: Record<string, unknown>): Record<string, unknown> {
  const result = { ...obj };
  for (const field of NUMERIC_FIELDS) {
    if (typeof result[field] === "string") {
      const num = Number(result[field]);
      if (!isNaN(num)) {
        result[field] = num;
      }
    }
  }
  return result;
}
