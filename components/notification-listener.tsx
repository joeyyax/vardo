"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/messenger";
import { useNotificationStream } from "@/hooks/use-notification-stream";
import { createRefreshScheduler, isRefreshEvent, type RefreshScheduler } from "@/lib/bus/refresh";
import { toastSeverityFor } from "@/lib/bus/toasts";
import type { BusEvent } from "@/lib/bus/events";

function showToast(event: BusEvent): void {
  const severity = toastSeverityFor(event);
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
 * Mounts in the app layout. Connects to the org notification SSE stream, maps
 * high-signal bus events to toasts and refreshes server data on anything that
 * changes app state — so a deploy started from the API, MCP or a webhook shows
 * up without a reload.
 *
 * Renders nothing visible — side-effect-only component.
 */
export function NotificationListener({ orgId }: { orgId: string }) {
  const router = useRouter();
  const schedulerRef = useRef<RefreshScheduler | null>(null);

  useEffect(() => {
    const scheduler = createRefreshScheduler(() => router.refresh());
    schedulerRef.current = scheduler;
    return () => {
      scheduler.cancel();
      schedulerRef.current = null;
    };
  }, [router]);

  const onEvent = useCallback((event: BusEvent & { historical?: boolean }) => {
    // Catch-up events fire after a reconnect, when the rendered data is already
    // behind — refresh for them, but don't replay their toasts.
    if (isRefreshEvent(event.type)) schedulerRef.current?.schedule();
    if (event.historical) return;
    showToast(event);
  }, []);

  useNotificationStream({ orgId, onEvent });

  return null;
}
