"use client";

import { useEffect, useRef } from "react";
import type { BusEvent } from "@/lib/bus/events";

/** Poll cadence while the stream is not connected. */
const FALLBACK_INTERVAL_MS = 10_000;

type UseAppEventsOptions = {
  orgId: string;
  appId: string;
  /** Runs for every event on the app's stream. */
  onEvent: (event: BusEvent) => void;
  /** Runs on the fallback timer while the stream is down. */
  onFallback: () => void;
};

/**
 * Subscribes to an app's SSE event stream.
 *
 * The route emits a single "update" event carrying the BusEvent. The polling
 * fallback is armed from mount and cleared once the stream opens, so a stream
 * that never connects is covered without waiting for an error.
 */
export function useAppEvents({ orgId, appId, onEvent, onFallback }: UseAppEventsOptions): void {
  const onEventRef = useRef(onEvent);
  const onFallbackRef = useRef(onFallback);

  useEffect(() => {
    onEventRef.current = onEvent;
    onFallbackRef.current = onFallback;
  });

  useEffect(() => {
    let es: EventSource | null = null;
    let fallback: ReturnType<typeof setInterval> | null = null;

    function armFallback() {
      if (fallback) return;
      fallback = setInterval(() => {
        if (document.visibilityState === "visible") onFallbackRef.current();
      }, FALLBACK_INTERVAL_MS);
    }

    function clearFallback() {
      if (fallback) clearInterval(fallback);
      fallback = null;
    }

    armFallback();

    try {
      es = new EventSource(`/api/v1/organizations/${orgId}/apps/${appId}/events`);
      es.onopen = () => clearFallback();
      es.addEventListener("update", (event: MessageEvent) => {
        try {
          onEventRef.current(JSON.parse(event.data) as BusEvent);
        } catch {
          // Skip malformed events
        }
      });
      es.onerror = () => armFallback();
    } catch {
      // Fallback is already running
    }

    return () => {
      es?.close();
      clearFallback();
    };
  }, [orgId, appId]);
}
