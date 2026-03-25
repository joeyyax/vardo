"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { BusEvent } from "@/lib/bus/events";

type UseNotificationStreamOptions = {
  orgId: string;
  enabled?: boolean;
  onEvent?: (event: BusEvent) => void;
};

type UseNotificationStreamReturn = {
  connected: boolean;
};

/**
 * EventSource hook for the org notification SSE stream.
 *
 * Connects to /api/v1/organizations/[orgId]/notifications/stream and
 * delivers typed BusEvents via the onEvent callback. Reconnects automatically
 * on disconnect and when the tab regains visibility.
 */
export function useNotificationStream(
  options: UseNotificationStreamOptions,
): UseNotificationStreamReturn {
  const { orgId, enabled = true, onEvent } = options;
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  const connect = useCallback(() => {
    if (!orgId) return null;

    const url = `/api/v1/organizations/${orgId}/notifications/stream`;
    const es = new EventSource(url);

    es.onopen = () => setConnected(true);

    es.addEventListener("notification", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as BusEvent;
        onEventRef.current?.(data);
      } catch {
        // Skip malformed events
      }
    });

    es.onerror = () => setConnected(false);

    return es;
  }, [orgId]);

  useEffect(() => {
    if (!enabled || !orgId) return;

    // Don't open while tab is hidden
    if (typeof document !== "undefined" && document.hidden) return;

    let es = connect();

    // Reconnect when tab becomes visible
    function handleVisibility() {
      if (document.hidden) {
        es?.close();
        es = null;
        setConnected(false);
      } else if (!es) {
        es = connect();
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      es?.close();
      setConnected(false);
    };
  }, [orgId, enabled, connect]);

  return { connected };
}
