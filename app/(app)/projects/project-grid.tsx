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

type ChildProject = {
  id: string;
  name: string;
  displayName: string;
  status: string;
  imageName: string | null;
  gitUrl: string | null;
  deployType: string;
  deployments: { id: string; status: string; finishedAt: Date | null }[];
  domains: { domain: string }[];
};

type ProjectWithRelations = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: string;
  deployType: string;
  imageName: string | null;
  gitUrl: string | null;
  parentId: string | null;
  color: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  domains: { domain: string; isPrimary: boolean | null }[];
  deployments: { id: string; status: string; startedAt: Date; finishedAt: Date | null }[];
  projectTags: { tag: Tag }[];
  parent: { id: string; name: string; color: string | null } | null;
  children: ChildProject[];
};

type ProjectGridProps = {
  projects: ProjectWithRelations[];
  allTags: Tag[];
  orgId: string;
};

type ProjectMetrics = {
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

/** Collect unique icons from parent + children (up to max) */
function collectIcons(
  parent: { imageName: string | null; gitUrl: string | null; deployType: string; name: string; displayName: string },
  children: ChildProject[],
  max: number,
): string[] {
  const icons: string[] = [];
  const seen = new Set<string>();

  const parentIcon = detectProjectIcon(parent);
  if (parentIcon && !seen.has(parentIcon)) {
    seen.add(parentIcon);
    icons.push(parentIcon);
  }

  for (const child of children) {
    if (icons.length >= max) break;
    const icon = detectProjectIcon({
      imageName: child.imageName,
      gitUrl: child.gitUrl,
      deployType: child.deployType,
      name: child.name,
      displayName: child.displayName,
    });
    if (icon && !seen.has(icon)) {
      seen.add(icon);
      icons.push(icon);
    }
  }

  return icons;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StackIcon({ project }: { project: ProjectWithRelations }) {
  const color = project.color || "#6366f1";
  const icons = collectIcons(project, project.children, 4);

  if (icons.length === 0) {
    return (
      <div
        className="size-12 shrink-0 rounded-md flex items-center justify-center"
        style={{ backgroundColor: `${color}20` }}
      >
        <span className="size-3 rounded-full" style={{ backgroundColor: color }} />
      </div>
    );
  }

  if (icons.length === 1) {
    return (
      <div
        className="size-12 shrink-0 rounded-md flex items-center justify-center"
        style={{ backgroundColor: `${color}10` }}
      >
        <img src={icons[0]} alt="" className="size-8 opacity-70" />
      </div>
    );
  }

  return (
    <div
      className="size-12 shrink-0 rounded-md grid grid-cols-2 gap-0.5 p-1"
      style={{ backgroundColor: `${color}10` }}
    >
      {icons.slice(0, 4).map((icon, i) => (
        <img key={i} src={icon} alt="" className="size-full opacity-60" />
      ))}
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

function StackStatus({ children }: { children: ChildProject[] }) {
  const allActive = children.every((c) => c.status === "active");
  const anyError = children.some((c) => c.status === "error");
  const anyDeploying = children.some((c) => c.status === "deploying");

  const status = allActive ? "running"
    : anyError ? "error"
    : anyDeploying ? "deploying"
    : "stopped";

  const latestFinish = allActive
    ? children.reduce<Date | null>((latest, c) => {
        const f = c.deployments[0]?.finishedAt;
        if (!f) return latest;
        const d = new Date(f);
        return !latest || d > latest ? d : latest;
      }, null)
    : null;

  return <StatusIndicator status={status} finishedAt={latestFinish} />;
}

function EndpointsPopover({ project }: { project: ProjectWithRelations }) {
  const endpoints: { label: string; domain: string }[] = [];

  for (const d of project.domains) {
    endpoints.push({ label: project.displayName, domain: d.domain });
  }
  for (const child of project.children) {
    for (const d of child.domains) {
      endpoints.push({ label: child.displayName, domain: d.domain });
    }
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
  metrics: ProjectMetrics;
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

function ProjectCard({
  project,
  metrics,
  history,
}: {
  project: ProjectWithRelations;
  metrics?: ProjectMetrics;
  history: MetricsHistory;
}) {
  const isStack = project.children.length > 0;
  const lastDeploy = project.deployments[0];
  const [hoveredMetric, setHoveredMetric] = useState<MetricKey | null>(null);
  const icon = detectProjectIcon({
    imageName: project.imageName,
    gitUrl: project.gitUrl,
    deployType: project.deployType,
    name: project.name,
    displayName: project.displayName,
  });

  const activeMetric = hoveredMetric || "cpu";

  return (
    <Link
      href={`/projects/${project.name}`}
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
        {isStack ? (
          <StackIcon project={project} />
        ) : icon ? (
          <img src={icon} alt="" className="size-12 shrink-0 opacity-70" />
        ) : (
          <div className="size-12 shrink-0 rounded-md bg-muted/50" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-base font-semibold truncate">
                {project.displayName}
              </h3>
              <EndpointsPopover project={project} />
            </div>
            {isStack ? (
              <StackStatus>{project.children}</StackStatus>
            ) : (
              <StatusIndicator
                status={
                  project.status === "active" ? "running"
                    : project.status === "error" ? "error"
                    : project.status === "deploying" ? "deploying"
                    : "stopped"
                }
                finishedAt={lastDeploy?.finishedAt}
              />
            )}
          </div>
          {project.description && (
            <p className="text-sm text-muted-foreground mt-1 truncate">
              {project.description}
            </p>
          )}
          {!project.description && !isStack && (
            <p className="text-sm text-muted-foreground/40 mt-1 truncate">
              {project.imageName ||
                project.gitUrl
                  ?.replace("https://github.com/", "")
                  .replace(".git", "") ||
                project.deployType}
            </p>
          )}
          {metrics && <MetricsLine metrics={metrics} onHover={setHoveredMetric} />}
          {project.projectTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {project.projectTags.map(({ tag }) => (
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

      {/* Child service chips */}
      {isStack && (
        <div className="relative flex flex-wrap gap-1.5 mt-3 pt-3 border-t">
          {project.children.map((child) => (
            <span
              key={child.id}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium bg-background"
            >
              <span className={`size-1.5 rounded-full ${statusDotColor(child.status)}`} />
              {child.displayName}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Metrics hook — loads history from Redis, then updates via SSE
// ---------------------------------------------------------------------------

const EMPTY_HISTORY: MetricsHistory = { cpu: [], memory: [], disk: [], network: [] };

function pushHistory(h: MetricsHistory, m: ProjectMetrics) {
  for (const key of ["cpu", "memory", "disk", "network"] as MetricKey[]) {
    const val = key === "cpu" ? m.cpuPercent
      : key === "memory" ? m.memoryUsage
      : key === "disk" ? m.diskUsage
      : m.networkRx + m.networkTx;
    h[key].push(val);
    if (h[key].length > SPARKLINE_POINTS) h[key].shift();
  }
}

function useProjectMetrics(orgId: string) {
  const [metrics, setMetrics] = useState<Map<string, ProjectMetrics>>(new Map());
  const historyRef = useRef<Map<string, MetricsHistory>>(new Map());
  const [historyTick, setHistoryTick] = useState(0);

  // Load last hour of per-project history for all metrics on mount
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
        for (const [projectId, series] of Object.entries(data.projects || {})) {
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
            historyRef.current.set(projectId, h);
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
          const next = new Map<string, ProjectMetrics>();

          for (const proj of data.projects || []) {
            let cpu = 0;
            let mem = 0;
            let memLimit = 0;
            let netRx = 0;
            let netTx = 0;
            for (const c of proj.containers || []) {
              cpu += c.cpuPercent;
              mem += c.memoryUsage;
              memLimit = Math.max(memLimit, c.memoryLimit);
              netRx += c.networkRx || 0;
              netTx += c.networkTx || 0;
            }
            // Disk comes from per-project Redis TimeSeries (volumes + containers), not cAdvisor
            const disk = proj.diskUsage || 0;
            const m: ProjectMetrics = { cpuPercent: cpu, memoryUsage: mem, memoryLimit: memLimit, diskUsage: disk, networkRx: netRx, networkTx: netTx };
            next.set(proj.id, m);

            // Append live point to all history channels
            if (!historyRef.current.has(proj.id)) {
              historyRef.current.set(proj.id, { cpu: [], memory: [], disk: [], network: [] });
            }
            pushHistory(historyRef.current.get(proj.id)!, m);
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

export function ProjectGrid({
  projects,
  allTags,
  orgId,
}: ProjectGridProps) {
  const router = useRouter();
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const { metrics, history } = useProjectMetrics(orgId);

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(interval);
  }, [router]);

  // Filter by tags, then hide child projects (they appear as chips on their parent)
  const filtered = useMemo(() => {
    let list = projects;
    if (activeTagIds.size > 0) {
      list = list.filter((p) => {
        const ids = new Set(p.projectTags.map((pt) => pt.tag.id));
        for (const tagId of activeTagIds) if (!ids.has(tagId)) return false;
        return true;
      });
    }
    return list.filter((p) => !p.parentId);
  }, [projects, activeTagIds]);

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
        {filtered.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            metrics={metrics.get(project.id)}
            history={history.get(project.id) || EMPTY_HISTORY}
          />
        ))}
      </div>

      {filtered.length === 0 && projects.length > 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">
            No projects match the current filters.
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
