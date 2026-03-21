"use client";

import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Cpu, Globe, HardDrive, MemoryStick, Network } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { detectProjectIcon } from "@/lib/ui/project-icon";
import { formatBytes } from "@/lib/metrics/format";

type Tag = { id: string; name: string; color: string };

type AppWithRelations = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: string;
  deployType: string;
  imageName: string | null;
  gitUrl: string | null;
  projectId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  domains: { domain: string; isPrimary: boolean | null }[];
  deployments: { id: string; status: string; startedAt: Date; finishedAt: Date | null }[];
  appTags: { tag: Tag }[];
  project: { id: string; name: string; displayName: string; color: string | null } | null;
};

type AppGridProps = {
  apps: AppWithRelations[];
  allTags: Tag[];
  orgId: string;
};

type AppMetrics = {
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  diskUsage: number;
  networkRx: number;
  networkTx: number;
};

type MetricKey = "cpu" | "memory" | "disk" | "network";

type MetricsHistory = {
  cpu: number[];
  memory: number[];
  disk: number[];
  network: number[];
};

// ---------------------------------------------------------------------------
// Sparkline — tiny SVG chart from an array of numbers
// ---------------------------------------------------------------------------

const SPARKLINE_POINTS = 20;

function Sparkline({ data, className }: { data: number[]; className?: string }) {
  if (data.length < 2) return null;

  // Scale so low values (~1%) are visible but don't fill the card,
  // while high values (~50%+) use most of the height.
  // Uses the data's own max but with a floor so it doesn't auto-scale tiny values to full height.
  const dataMax = Math.max(...data, 0.1);
  const ceiling = Math.max(dataMax * 3, 10);
  const w = 64;
  const h = 20;
  const points = data
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
// Helpers
// ---------------------------------------------------------------------------

function statusDotColor(status: string) {
  return status === "active" ? "bg-status-success"
    : status === "error" ? "bg-status-error"
    : status === "deploying" ? "bg-status-info"
    : "bg-status-neutral";
}

function formatUptime(date: Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / 86400000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Uptime({ since }: { since: Date }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(formatUptime(since));
    const interval = setInterval(() => setText(formatUptime(since)), 1000);
    return () => clearInterval(interval);
  }, [since]);
  if (!text) return null;
  return <span className="tabular-nums">{text}</span>;
}

/** Get the icon for an app */
function getAppIcon(app: { imageName: string | null; gitUrl: string | null; deployType: string; name: string; displayName: string }): string | null {
  return detectProjectIcon(app);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AppIcon({ app }: { app: AppWithRelations }) {
  const color = app.project?.color || "#6366f1";
  const icon = getAppIcon(app);

  if (!icon) {
    return (
      <div
        className="size-12 shrink-0 rounded-md flex items-center justify-center"
        style={{ backgroundColor: `${color}20` }}
      >
        <span className="size-3 rounded-full" style={{ backgroundColor: color }} />
      </div>
    );
  }

  return (
    <div
      className="size-12 shrink-0 rounded-md flex items-center justify-center"
      style={{ backgroundColor: `${color}10` }}
    >
      <img src={icon} alt="" className="size-8 opacity-70" />
    </div>
  );
}

function StatusIndicator({
  status,
  finishedAt,
}: {
  status: "running" | "error" | "deploying" | "stopped";
  finishedAt?: Date | null;
}) {
  switch (status) {
    case "running":
      return (
        <span className="flex items-center gap-1.5 text-sm text-status-success shrink-0">
          <span className="size-2 rounded-full bg-status-success animate-pulse" />
          {finishedAt ? <Uptime since={finishedAt} /> : "Running"}
        </span>
      );
    case "error":
      return <span className="text-sm text-status-error shrink-0">Error</span>;
    case "deploying":
      return <span className="text-sm text-status-info animate-pulse shrink-0">Deploying</span>;
    default:
      return <span className="text-sm text-status-neutral shrink-0">Stopped</span>;
  }
}


function EndpointsPopover({ app }: { app: AppWithRelations }) {
  const endpoints: { label: string; domain: string }[] = [];

  for (const d of app.domains) {
    endpoints.push({ label: app.displayName, domain: d.domain });
  }

  if (endpoints.length === 0) return null;

  if (endpoints.length === 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={`https://${endpoints[0].domain}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          >
            <Globe className="size-3.5" />
          </a>
        </TooltipTrigger>
        <TooltipContent side="bottom">{endpoints[0].domain}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.preventDefault()}
          className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
        >
          <Globe className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-0.5">
          {endpoints.map((ep) => (
            <a
              key={ep.domain}
              href={`https://${ep.domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
            >
              <span className="truncate text-muted-foreground">{ep.label}</span>
              <span className="truncate font-mono text-xs text-foreground">{ep.domain}</span>
            </a>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MetricChip({
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

function MetricsLine({
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
        <MetricChip label={`↓ ${formatBytes(metrics.networkRx)} ↑ ${formatBytes(metrics.networkTx)}`} metric="network" onHover={onHover}>
          <Network className="size-3" />
          {formatBytes(metrics.networkRx + metrics.networkTx)}
        </MetricChip>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ProjectCard
// ---------------------------------------------------------------------------

function AppCard({
  app,
  metrics,
  history,
}: {
  app: AppWithRelations;
  metrics?: AppMetrics;
  history: MetricsHistory;
}) {
  const lastDeploy = app.deployments[0];
  const [hoveredMetric, setHoveredMetric] = useState<MetricKey | null>(null);

  const activeMetric = hoveredMetric || "cpu";

  return (
    <Link
      href={`/apps/${app.name}`}
      className="squircle relative flex flex-col rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 overflow-hidden"
    >
      {/* Background sparklines — crossfade on hover */}
      {(["cpu", "memory", "disk", "network"] as MetricKey[]).map((key) => {
        const data = history[key];
        if (data.length < 2) return null;
        return (
          <Sparkline
            key={key}
            data={data}
            className={`absolute inset-0 w-full h-full text-foreground pointer-events-none transition-opacity duration-300 ${
              activeMetric === key ? "opacity-100" : "opacity-0"
            }`}
          />
        );
      })}

      <div className="relative flex gap-4">
        <AppIcon app={app} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-base font-semibold truncate">
                {app.displayName}
              </h3>
              <EndpointsPopover app={app} />
            </div>
            <StatusIndicator
              status={
                app.status === "active" ? "running"
                  : app.status === "error" ? "error"
                  : app.status === "deploying" ? "deploying"
                  : "stopped"
              }
              finishedAt={lastDeploy?.finishedAt}
            />
          </div>
          {app.description && (
            <p className="text-sm text-muted-foreground mt-1 truncate">
              {app.description}
            </p>
          )}
          {!app.description && (
            <p className="text-sm text-muted-foreground/40 mt-1 truncate">
              {app.imageName ||
                app.gitUrl
                  ?.replace("https://github.com/", "")
                  .replace(".git", "") ||
                app.deployType}
            </p>
          )}
          {metrics && <MetricsLine metrics={metrics} onHover={setHoveredMetric} />}
          {app.appTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {app.appTags.map(({ tag }) => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{
                    backgroundColor: `${tag.color}15`,
                    color: tag.color,
                  }}
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Project badge */}
      {app.project && (
        <div className="relative flex flex-wrap gap-1.5 mt-3 pt-3 border-t">
          <Link
            href={`/projects/${app.project.name}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium bg-background hover:bg-accent transition-colors"
          >
            <span className="size-1.5 rounded-full" style={{ backgroundColor: app.project.color || "#6366f1" }} />
            {app.project.displayName}
          </Link>
        </div>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Metrics hook — loads history from Redis, then updates via SSE
// ---------------------------------------------------------------------------

const EMPTY_HISTORY: MetricsHistory = { cpu: [], memory: [], disk: [], network: [] };

function pushHistory(h: MetricsHistory, m: AppMetrics) {
  for (const key of ["cpu", "memory", "disk", "network"] as MetricKey[]) {
    const val = key === "cpu" ? m.cpuPercent
      : key === "memory" ? m.memoryUsage
      : key === "disk" ? m.diskUsage
      : m.networkRx + m.networkTx;
    h[key].push(val);
    if (h[key].length > SPARKLINE_POINTS) h[key].shift();
  }
}

function useAppMetrics(orgId: string) {
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

// ---------------------------------------------------------------------------
// ProjectGrid
// ---------------------------------------------------------------------------

export function AppGrid({
  apps,
  allTags,
  orgId,
}: AppGridProps) {
  const router = useRouter();
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const { metrics, history } = useAppMetrics(orgId);

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(interval);
  }, [router]);

  // Filter by tags, then hide child apps (they appear as chips on their parent)
  const filtered = useMemo(() => {
    let list = apps;
    if (activeTagIds.size > 0) {
      list = list.filter((p) => {
        const ids = new Set(p.appTags.map((pt) => pt.tag.id));
        for (const tagId of activeTagIds) if (!ids.has(tagId)) return false;
        return true;
      });
    }
    return list;
  }, [apps, activeTagIds]);

  return (
    <div className="space-y-4">
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {allTags.map((tag) => {
            const on = activeTagIds.has(tag.id);
            return (
              <button
                key={tag.id}
                onClick={() =>
                  setActiveTagIds((prev) => {
                    const n = new Set(prev);
                    if (n.has(tag.id)) n.delete(tag.id);
                    else n.add(tag.id);
                    return n;
                  })
                }
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  on
                    ? "text-white"
                    : "border bg-background text-foreground hover:bg-accent"
                }`}
                style={
                  on
                    ? { backgroundColor: tag.color }
                    : { borderColor: `${tag.color}40` }
                }
              >
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
              </button>
            );
          })}
          {activeTagIds.size > 0 && (
            <button
              onClick={() => setActiveTagIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((app) => (
          <AppCard
            key={app.id}
            app={app}
            metrics={metrics.get(app.id)}
            history={history.get(app.id) || EMPTY_HISTORY}
          />
        ))}
      </div>

      {filtered.length === 0 && apps.length > 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">
            No apps match the current filters.
          </p>
          <button
            onClick={() => setActiveTagIds(new Set())}
            className="text-sm text-primary hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
