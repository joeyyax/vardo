"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/messenger";
import { useNotificationStream } from "@/hooks/use-notification-stream";
import { INFRA_RECHECK_EVENT } from "@/lib/attention/infrastructure-view";
import { createRefreshScheduler, isRefreshEvent, type RefreshScheduler } from "@/lib/bus/refresh";
import { toastSeverityFor } from "@/lib/bus/toasts";
import { toastActionFor } from "@/lib/bus/toast-action";
import type { BusEvent } from "@/lib/bus/events";

function showToast(event: BusEvent, canLinkToAdmin: boolean, navigate: (url: string) => void): void {
  const severity = toastSeverityFor(event);
  if (!severity) return;

  const link = toastActionFor(event, { canLinkToAdmin });
  const options = {
    description: event.message,
    action: link ? { label: link.label, onClick: () => navigate(link.url) } : undefined,
  };

  switch (severity) {
    case "success":
      toast.success(event.title, options);
      break;
    case "error":
      toast.error(event.title, options);
      break;
    case "warning":
      toast.warning(event.title, options);
      break;
    default:
      toast.info(event.title, options);
      break;
  }
}

/**
 * Maps org notification events to toasts and refreshes server data on app state changes.
 * Renders nothing.
 */
export function NotificationListener({
  orgId,
  canLinkToAdmin = false,
}: {
  orgId: string;
  canLinkToAdmin?: boolean;
}) {
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
    // Catch-up events after a reconnect refresh but don't toast.
    if (isRefreshEvent(event.type)) {
      schedulerRef.current?.schedule();
      // Bring the infrastructure poll forward.
      window.dispatchEvent(new Event(INFRA_RECHECK_EVENT));
    }
    if (event.historical) return;
    showToast(event, canLinkToAdmin, (url) => router.push(url));
  }, [canLinkToAdmin, router]);

  useNotificationStream({ orgId, onEvent });

  return null;
}
