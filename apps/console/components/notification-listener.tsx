"use client";

import { useCallback } from "react";
import { toast } from "@/lib/messenger";
import { useNotificationStream } from "@/lib/hooks/use-notification-stream";
import type { BusEvent, BusEventType } from "@/lib/bus/events";

/**
 * Event types that auto-toast. Low-signal events (digests, invitations,
 * update notices) are excluded — they belong in a notification panel, not
 * interrupting the user mid-session.
 */
const TOAST_EVENTS: Partial<Record<BusEventType, "success" | "error" | "info">> = {
  "deploy.success": "success",
  "deploy.failed": "error",
  "deploy.rollback": "error",
  "backup.success": "success",
  "backup.failed": "error",
  "cron.failed": "error",
  "disk.write-alert": "error",
  "system.service-down": "error",
  "system.disk-alert": "error",
  "system.restart-loop": "error",
  "system.cert-expiring": "error",
};

function showToast(event: BusEvent): void {
  const severity = TOAST_EVENTS[event.type];
  if (!severity) return;

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
 * and maps high-signal bus events to sonner toasts.
 *
 * Renders nothing visible — side-effect-only component.
 */
export function NotificationListener({ orgId }: { orgId: string }) {
  const onEvent = useCallback((event: BusEvent) => {
    showToast(event);
  }, []);

  useNotificationStream({ orgId, onEvent });

  return null;
}
