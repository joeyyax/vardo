"use client";

import { useState, useEffect, useRef } from "react";
import type { BusEvent } from "@/lib/bus/events";

type UseNotificationStreamOptions = {
  orgId: string;
  /** Whether the stream is enabled (default true). Set false to disconnect. */
  enabled?: boolean;
};

type UseNotificationStreamReturn = {
  /** Whether the SSE stream is connected */
  connected: boolean;
  /** Latest event received (null until the first event arrives) */
  lastEvent: BusEvent | null;
};

/**
 * EventSource hook for the org notification SSE stream.
 *
 * Connects to /api/v1/organizations/[orgId]/notifications/stream and
 * yields typed BusEvents as they arrive. Automatically reconnects on
 * disconnect (via the browser's built-in EventSource retry).
 */
export function useNotificationStream(
  options: UseNotificationStreamOptions,
): UseNotificationStreamReturn {
  const { orgId, enabled = true } = options;
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<BusEvent | null>(null);
  const wasConnectedRef = useRef(false);

  useEffect(() => {
    if (!enabled || !orgId) return;

    // Don't open a connection while the tab is hidden
    if (typeof document !== "undefined" && document.hidden) return;

    const url = `/api/v1/organizations/${orgId}/notifications/stream`;
    const es = new EventSource(url);

    es.onopen = () => {
      setConnected(true);
      wasConnectedRef.current = true;
    };

    // Listen for all SSE events by handling the generic "message" event
    // and also specific event types. Since we send events with custom
    // event names (deploy-success, etc.), we use onmessage as a fallback
    // and add specific listeners for each category prefix.
    function handleEvent(event: MessageEvent) {
      try {
        const data = JSON.parse(event.data) as BusEvent;
        setLastEvent(data);
      } catch {
        // Skip malformed events
      }
    }

    // SSE custom event types use hyphenated names (deploy-success, etc.)
    const eventTypes = [
      "deploy-success",
      "deploy-failed",
      "deploy-rollback",
      "backup-success",
      "backup-failed",
      "cron-failed",
      "volume-drift",
      "disk-write-alert",
      "org-invitation-sent",
      "org-invitation-accepted",
      "system-service-down",
      "system-disk-alert",
      "system-restart-loop",
      "system-cert-expiring",
      "system-update-available",
      "digest-weekly",
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, handleEvent);
    }

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [orgId, enabled]);

  return { connected, lastEvent };
}
