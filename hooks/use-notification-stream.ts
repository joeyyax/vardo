"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { BusEvent } from "@/lib/bus/events";

const LAST_ID_KEY = "vardo:notification-stream:lastId";

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
 *
 * Tracks the last received stream ID in localStorage so reconnections
 * (including page refreshes) only receive new events.
 */
export function useNotificationStream(
  options: UseNotificationStreamOptions,
): UseNotificationStreamReturn {
  const { orgId, enabled = true, onEvent } = options;
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    onEventRef.current = onEvent;
  });

  // Restore last seen ID from localStorage on mount
  useEffect(() => {
    try {
      lastIdRef.current = localStorage.getItem(`${LAST_ID_KEY}:${orgId}`);
    } catch {
      // localStorage unavailable
    }
  }, [orgId]);

  const connect = useCallback(() => {
    if (!orgId) return null;

    let url = `/api/v1/organizations/${orgId}/notifications/stream`;
    if (lastIdRef.current) {
      url += `?lastId=${encodeURIComponent(lastIdRef.current)}`;
    }
    const es = new EventSource(url);

    es.onopen = () => setConnected(true);

    es.addEventListener("notification", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as BusEvent & { streamId?: string };
        // Track the stream cursor for resumption
        if (data.streamId) {
          lastIdRef.current = data.streamId;
          try {
            localStorage.setItem(`${LAST_ID_KEY}:${orgId}`, data.streamId);
          } catch {
            // localStorage unavailable
          }
        }
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
