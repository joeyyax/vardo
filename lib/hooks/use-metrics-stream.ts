"use client";

import { useState, useEffect, useRef } from "react";
import { useVisibilityKey } from "./use-visible";
import {
  RANGE_MS,
  BUCKET_MS,
  type TimeRange,
} from "@/lib/metrics/constants";
import type { MetricsPoint, ContainerPoint } from "@/lib/metrics/types";

type MetricsMeta = {
  disk: unknown;
  system: unknown;
  apps: unknown[];
  projectCount?: number;
  [key: string]: unknown;
};

type UseMetricsStreamOptions = {
  /** URL for historical data: GET returns { points: MetricsPoint[] } */
  historyUrl: string;
  /** URL for SSE stream: emits event:point with MetricsPoint data */
  streamUrl: string;
  /** Current time range selection */
  timeRange: TimeRange;
  /** Max points to keep in memory (default 500) */
  maxPoints?: number;
};

type UseMetricsStreamReturn = {
  /** Unified chart data -- historical + live appended */
  points: MetricsPoint[];
  /** Latest container breakdown (from SSE events that include containers) */
  containers: ContainerPoint[];
  /** Auxiliary metadata (disk, system info) from SSE */
  meta: MetricsMeta | null;
  /** Whether the SSE stream is connected */
  connected: boolean;
  /** Whether historical data is still loading */
  loading: boolean;
};

export function useMetricsStream(
  options: UseMetricsStreamOptions,
): UseMetricsStreamReturn {
  const { historyUrl, streamUrl, timeRange, maxPoints = 500 } = options;

  const [points, setPoints] = useState<MetricsPoint[]>([]);
  const [containers, setContainers] = useState<ContainerPoint[]>([]);
  const [meta, setMeta] = useState<MetricsMeta | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  const visKey = useVisibilityKey();

  // Keep timeRange in a ref so the SSE effect can read the latest value
  // without re-opening the connection when the range changes.
  const timeRangeRef = useRef(timeRange);
  timeRangeRef.current = timeRange;

  // ---- Historical fetch ----
  // Re-fetches whenever the time range or history URL changes.
  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const from = now - RANGE_MS[timeRange];
    const bucket = BUCKET_MS[timeRange];

    setLoading(true);

    const separator = historyUrl.includes("?") ? "&" : "?";
    const url = `${historyUrl}${separator}from=${from}&to=${now}&bucket=${bucket}`;

    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setPoints(data.points ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setPoints([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [historyUrl, timeRange]);

  // ---- SSE stream ----
  // Reconnects when streamUrl changes or when the visibility key bumps.
  useEffect(() => {
    // Don't open a connection while the tab is hidden.
    if (typeof document !== "undefined" && document.hidden) return;

    const es = new EventSource(streamUrl);

    es.onopen = () => setConnected(true);

    function handlePoint(event: MessageEvent) {
      try {
        const data = JSON.parse(event.data);

        const point: MetricsPoint = {
          timestamp: data.timestamp ?? Date.now(),
          cpu: data.cpu ?? 0,
          memory: data.memory ?? 0,
          memoryLimit: data.memoryLimit ?? 0,
          networkRx: data.networkRx ?? 0,
          networkTx: data.networkTx ?? 0,
          diskTotal: data.diskTotal ?? 0,
        };

        // Container breakdown — optional per event
        if (data.containers) {
          setContainers(data.containers as ContainerPoint[]);
        }

        // Auxiliary metadata — merge incrementally
        if (data.disk || data.system || data.apps || data.projectCount !== undefined) {
          setMeta((prev) => ({
            disk: data.disk ?? prev?.disk ?? null,
            system: data.system ?? prev?.system ?? null,
            apps: data.apps ?? prev?.apps ?? [],
            projectCount: data.projectCount ?? prev?.projectCount,
          }));
        }

        // Append live point, trimming outside the current range
        const cutoff = Date.now() - RANGE_MS[timeRangeRef.current];
        setPoints((prev) => {
          const next = [...prev, point];
          const filtered = next.filter((p) => p.timestamp >= cutoff);
          return filtered.length > maxPoints
            ? filtered.slice(-maxPoints)
            : filtered;
        });
      } catch {
        // Skip malformed events
      }
    }

    es.addEventListener("point", handlePoint);

    // Backward-compatible: handle legacy "stats" events the same way.
    es.addEventListener("stats", handlePoint);

    es.addEventListener("timeout", () => {
      setConnected(false);
      es.close();
    });

    es.onerror = () => setConnected(false);

    return () => {
      es.close();
    };
  }, [streamUrl, visKey, maxPoints]);

  return { points, containers, meta, connected, loading };
}
