"use client";

import { useState, useEffect, useRef } from "react";
import { Cpu, HardDrive, MemoryStick, Network } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/metrics/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppMetrics = {
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  diskUsage: number;
  networkRx: number;
  networkTx: number;
};

export type MetricKey = "cpu" | "memory" | "disk" | "network";

export type MetricsHistory = {
  cpu: number[];
  memory: number[];
  disk: number[];
  network: number[];
};

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

export const SPARKLINE_POINTS = 20;

export const EMPTY_HISTORY: MetricsHistory = { cpu: [], memory: [], disk: [], network: [] };

export function pushHistory(h: MetricsHistory, m: AppMetrics) {
  for (const key of ["cpu", "memory", "disk", "network"] as MetricKey[]) {
    const val = key === "cpu" ? m.cpuPercent
      : key === "memory" ? m.memoryUsage
      : key === "disk" ? m.diskUsage
      : m.networkRx + m.networkTx;
    h[key].push(val);
    if (h[key].length > SPARKLINE_POINTS) h[key].shift();
  }
}

// ---------------------------------------------------------------------------
// Sparkline — tiny SVG chart from an array of numbers
// ---------------------------------------------------------------------------

export function Sparkline({ data, className }: { data: number[]; className?: string }) {
  if (data.length === 0) return null;
  // Single point — duplicate it to draw a flat line
  const plotData = data.length === 1 ? [data[0], data[0]] : data;

  // Scale so low values (~1%) are visible but don't fill the card,
  // while high values (~50%+) use most of the height.
  // Uses the data's own max but with a floor so it doesn't auto-scale tiny values to full height.
  const dataMax = Math.max(...plotData, 0.1);
  const ceiling = Math.max(dataMax * 3, 10);
  const w = 64;
  const h = 20;
  const points = plotData
    .slice(-SPARKLINE_POINTS)
    .map((v, i, arr) => {
      const x = (i / (arr.length - 1)) * w;
      const y = h - (v / ceiling) * h;
      return `${x},${y}`;
    })
    .join(" ");

  // Build filled area path: line across top, then close along bottom
  const fillPoints = `0,${h} ${points} ${w},${h}`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={className}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.12" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={fillPoints}
        fill="url(#sparkFill)"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// MetricChip & MetricsLine
// ---------------------------------------------------------------------------

export function MetricChip({
  label,
  metric,
  onHover,
  children,
}: {
  label: string;
  metric: MetricKey;
  onHover: (metric: MetricKey | null) => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex items-center gap-1 cursor-default"
          onMouseEnter={() => onHover(metric)}
          onMouseLeave={() => onHover(null)}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function MetricsLine({
  metrics,
  onHover,
}: {
  metrics: AppMetrics;
  onHover: (metric: MetricKey | null) => void;
}) {
  return (
    <span className="flex items-center gap-2.5 text-xs text-muted-foreground tabular-nums flex-wrap">
      <MetricChip label="CPU" metric="cpu" onHover={onHover}>
        <Cpu className="size-3" />
        {metrics.cpuPercent.toFixed(1)}%
      </MetricChip>
      <MetricChip label="Memory" metric="memory" onHover={onHover}>
        <MemoryStick className="size-3" />
        {formatBytes(metrics.memoryUsage)}
      </MetricChip>
      {metrics.diskUsage > 0 && (
        <MetricChip label="Storage" metric="disk" onHover={onHover}>
          <HardDrive className="size-3" />
          {formatBytes(metrics.diskUsage)}
        </MetricChip>
      )}
      {(metrics.networkRx > 0 || metrics.networkTx > 0) && (
        <MetricChip label={`\u2193 ${formatBytes(metrics.networkRx)} \u2191 ${formatBytes(metrics.networkTx)}`} metric="network" onHover={onHover}>
          <Network className="size-3" />
          {formatBytes(metrics.networkRx + metrics.networkTx)}
        </MetricChip>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// useAppMetrics hook — loads history from Redis, then updates via SSE
// ---------------------------------------------------------------------------

export function useAppMetrics(orgId: string) {
  const [metrics, setMetrics] = useState<Map<string, AppMetrics>>(new Map());
  const historyRef = useRef<Map<string, MetricsHistory>>(new Map());
  const [historyTick, setHistoryTick] = useState(0);

  // Load last hour of per-app history for all metrics on mount
  useEffect(() => {
    async function loadHistory() {
      try {
        const now = Date.now();
        const from = now - 3600000;
        const res = await fetch(
          `/api/v1/organizations/${orgId}/stats?from=${from}&to=${now}&bucket=60000&perProject=true&metric=cpu`
        );
        if (!res.ok) return;
        const data = await res.json();
        for (const [appId, series] of Object.entries(data.apps || {})) {
          const s = series as { cpu: [number, number][]; memory: [number, number][]; networkRx: [number, number][]; networkTx: [number, number][]; disk: [number, number][] };
          const cpuPoints = (s.cpu || []).map(([, v]) => v);
          const memPoints = (s.memory || []).map(([, v]) => v);
          const diskPoints = (s.disk || []).map(([, v]) => v);
          const networkPoints = (s.networkRx || []).map(([, v], i) => v + ((s.networkTx || [])[i]?.[1] || 0));
          if (cpuPoints.length > 0 || memPoints.length > 0) {
            const h: MetricsHistory = {
              cpu: cpuPoints.slice(-SPARKLINE_POINTS),
              memory: memPoints.slice(-SPARKLINE_POINTS),
              disk: diskPoints.slice(-SPARKLINE_POINTS),
              network: networkPoints.slice(-SPARKLINE_POINTS),
            };
            historyRef.current.set(appId, h);
          }
        }
        setHistoryTick((t) => t + 1);
      } catch { /* history is optional */ }
    }
    loadHistory();
  }, [orgId]);

  // Subscribe to live updates via SSE
  useEffect(() => {
    const url = `/api/v1/organizations/${orgId}/stats/stream`;
    let es: EventSource | null = null;

    try {
      es = new EventSource(url);

      es.addEventListener("stats", (event) => {
        try {
          const data = JSON.parse(event.data);
          const next = new Map<string, AppMetrics>();

          for (const a of data.apps || []) {
            let cpu = 0;
            let mem = 0;
            let memLimit = 0;
            let netRx = 0;
            let netTx = 0;
            for (const c of a.containers || []) {
              cpu += c.cpuPercent;
              mem += c.memoryUsage;
              memLimit = Math.max(memLimit, c.memoryLimit);
              netRx += c.networkRx || 0;
              netTx += c.networkTx || 0;
            }
            // Disk comes from per-app Redis TimeSeries (volumes + containers), not cAdvisor
            const disk = a.diskUsage || 0;
            const m: AppMetrics = { cpuPercent: cpu, memoryUsage: mem, memoryLimit: memLimit, diskUsage: disk, networkRx: netRx, networkTx: netTx };
            next.set(a.id, m);

            // Append live point to all history channels
            if (!historyRef.current.has(a.id)) {
              historyRef.current.set(a.id, { cpu: [], memory: [], disk: [], network: [] });
            }
            pushHistory(historyRef.current.get(a.id)!, m);
          }

          setMetrics(next);
          setHistoryTick((t) => t + 1);
        } catch { /* malformed event */ }
      });

      es.onerror = () => {
        es?.close();
      };
    } catch { /* EventSource not available */ }

    return () => es?.close();
  }, [orgId]);

  return { metrics, history: historyRef.current, historyTick };
}
