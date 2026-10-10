"use client";

import { useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/messenger";
import { useNotificationStream } from "@/hooks/use-notification-stream";
import { INFRA_RECHECK_EVENT } from "@/lib/attention/infrastructure-view";
import { createRefreshScheduler, isRefreshEvent, type RefreshScheduler } from "@/lib/bus/refresh";
import { toastSeverityFor } from "@/lib/bus/toasts";
import { toastActionFor } from "@/lib/bus/toast-action";
import type { BusEvent } from "@/lib/bus/events";

let toastSeq = 0;

function showToast(event: BusEvent, canLinkToAdmin: boolean): void {
  const severity = toastSeverityFor(event);
  if (!severity) return;

  const link = toastActionFor(event, { canLinkToAdmin });
  const id = `bus-${++toastSeq}`;
  // A real link, so Cmd/Ctrl-click and middle-click open a new tab.
  const action = link ? (
    <Link href={link.url} data-button data-action onClick={() => toast.dismiss(id)}>
      {link.label}
    </Link>
  ) : undefined;
  const options = { id, description: event.message, action };

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
    showToast(event, canLinkToAdmin);
  }, [canLinkToAdmin]);

  useNotificationStream({ orgId, onEvent });

  return null;
}
