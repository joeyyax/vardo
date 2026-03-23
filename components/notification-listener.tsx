"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useNotificationStream } from "@/lib/hooks/use-notification-stream";
import type { BusEvent, BusEventType } from "@/lib/bus/events";

/**
 * Map of event types to their toast severity. Events not listed here
 * default to "info" style.
 */
const EVENT_SEVERITY: Record<BusEventType, "success" | "error" | "info"> = {
  "deploy.success": "success",
  "deploy.failed": "error",
  "deploy.rollback": "error",
  "backup.success": "success",
  "backup.failed": "error",
  "cron.failed": "error",
  "volume.drift": "info",
  "disk.write-alert": "error",
  "org.invitation-sent": "info",
  "org.invitation-accepted": "success",
  "system.service-down": "error",
  "system.disk-alert": "error",
  "system.restart-loop": "error",
  "system.cert-expiring": "error",
  "system.update-available": "info",
  "digest.weekly": "info",
};

/**
 * Shows a sonner toast for each bus event based on its severity.
 */
function showToast(event: BusEvent): void {
  const severity = EVENT_SEVERITY[event.type] ?? "info";
  const options = { description: event.message };

  switch (severity) {
    case "success":
      toast.success(event.title, options);
      break;
    case "error":
      toast.error(event.title, options);
      break;
    default:
      toast.info(event.title, options);
      break;
  }
}

/**
 * Mounts in the app layout. Connects to the org notification SSE stream
 * and maps bus events to sonner toasts.
 *
 * Renders nothing visible — it's a side-effect-only component.
 */
export function NotificationListener({ orgId }: { orgId: string }) {
  const { lastEvent } = useNotificationStream({ orgId });
  const prevEventRef = useRef<BusEvent | null>(null);

  useEffect(() => {
    // Only fire for new events, not re-renders with the same event
    if (!lastEvent) return;
    if (lastEvent === prevEventRef.current) return;
    prevEventRef.current = lastEvent;

    showToast(lastEvent);
  }, [lastEvent]);

  return null;
}
