"use client";

import { useState, useEffect, useRef, useId } from "react";
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

// Build a smooth cubic bezier path through points (monotone spline like Recharts)
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]}L${pts[1][0]},${pts[1][1]}`;

  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    // Catmull-Rom to cubic bezier control points
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${cp1x},${cp1y},${cp2x},${cp2y},${p2[0]},${p2[1]}`;
  }
  return d;
}

export function Sparkline({ data, className, style }: { data: number[]; className?: string; style?: React.CSSProperties }) {
  const id = useId();
  if (data.length === 0) return null;
  const plotData = data.length === 1 ? [data[0], data[0]] : data;

  const dataMax = Math.max(...plotData, 0.1);
  const ceiling = Math.max(dataMax * 3, 10);
  const w = 64;
  const h = 20;
  const pts: [number, number][] = plotData
    .slice(-SPARKLINE_POINTS)
    .map((v, i, arr) => [
      (i / (arr.length - 1)) * w,
      h - (v / ceiling) * h,
    ]);

  const linePath = smoothPath(pts);
  // Closed fill path: line curve + straight bottom edge
  const fillPath = `${linePath}L${pts[pts.length - 1][0]},${h}L${pts[0][0]},${h}Z`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={className}
      style={style}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.12" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${id})`} />
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="0.5"
        vectorEffect="non-scaling-stroke"
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
  children,
}: {
  label: string;
  metric: MetricKey;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1 cursor-default" data-metric={metric}>
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
  function handleMove(e: React.MouseEvent) {
    const target = (e.target as HTMLElement).closest("[data-metric]");
    const metric = target?.getAttribute("data-metric") as MetricKey | null;
    onHover(metric);
  }

  return (
    <span
      className="flex items-center gap-2.5 text-xs text-muted-foreground tabular-nums flex-wrap"
      onMouseMove={handleMove}
      onMouseLeave={() => onHover(null)}
    >
      <MetricChip label="CPU" metric="cpu">
        <Cpu className="size-3" />
        {metrics.cpuPercent.toFixed(1)}%
      </MetricChip>
      <MetricChip label="Memory" metric="memory">
        <MemoryStick className="size-3" />
        {formatBytes(metrics.memoryUsage)}
      </MetricChip>
      {metrics.diskUsage > 0 && (
        <MetricChip label="Storage" metric="disk">
          <HardDrive className="size-3" />
          {formatBytes(metrics.diskUsage)}
        </MetricChip>
      )}
      {(metrics.networkRx > 0 || metrics.networkTx > 0) && (
        <MetricChip label={`\u2193 ${formatBytes(metrics.networkRx)} \u2191 ${formatBytes(metrics.networkTx)}`} metric="network">
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
          `/api/v1/organizations/${orgId}/stats?from=${from}&to=${now}&bucket=60000&perProject=true`
        );
        if (!res.ok) {
          console.warn("[metrics] History API returned", res.status);
          return;
        }
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
      } catch (err) {
        console.warn("[metrics] History load failed:", err);
      }
    }
    loadHistory();
  }, [orgId]);

  // Subscribe to live updates via SSE with reconnection
  useEffect(() => {
    const url = `/api/v1/organizations/${orgId}/stats/stream`;
    let es: EventSource | null = null;
    let retryDelay = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;
      try {
        es = new EventSource(url);

        es.addEventListener("stats", (event) => {
          retryDelay = 1000; // reset on successful message
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
              const disk = a.diskUsage || 0;
              const m: AppMetrics = { cpuPercent: cpu, memoryUsage: mem, memoryLimit: memLimit, diskUsage: disk, networkRx: netRx, networkTx: netTx };
              next.set(a.id, m);

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
          es = null;
          if (!disposed) {
            retryTimer = setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30000);
          }
        };
      } catch { /* EventSource not available */ }
    }

    connect();

    return () => {
      disposed = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [orgId]);

  // eslint-disable-next-line react-hooks/refs
  return { metrics, history: historyRef.current, historyTick };
}
