import { formatDistanceToNowStrict } from "date-fns";
import { CircleDashed, Cpu, Package, ShieldCheck, type LucideIcon } from "lucide-react";

import { formatBytes, formatCores } from "@/lib/metrics/format";
import { readingLabel, restartNote } from "@/lib/ui/app-row";
import { statusDotColor } from "@/lib/ui/status-colors";
import { conditionLabel, conditionTone } from "@/lib/ui/conditions";
import type { AppCondition } from "@/lib/docker/conditions";

export type AppRowCardApp = {
  displayName: string;
  status: string;
  imageName: string | null;
  containerStartedAt: Date | null;
  containerMemoryLimit?: number | null;
  priority?: "critical" | "standard" | "disposable" | null;
  gpuEnabled: boolean | null;
  needsRedeploy: boolean | null;
  /** Restarts the reconciler last counted, null when there was nothing to read. */
  restartCount?: number | null;
  conditions: AppCondition[] | null;
  domains?: { domain: string; isPrimary: boolean | null }[];
  deployments?: { status: string; startedAt: Date }[];
  appTags?: { tag: { name: string } }[];
  dependsOn?: string[] | null;
};

/** Live usage, as the row's sparkline plots it. Absent when nothing reported. */
export type AppRowCardUsage = { cpuPercent: number; memoryUsage: number };

const STATUS_LABEL: Record<string, string> = {
  active: "Running",
  stopped: "Stopped",
  error: "Crashed",
  deploying: "Deploying",
  missing: "No container",
};

/** Memory row label. null = never observed. 0 = observed and uncapped. */
export function memoryLimitLabel(containerMemoryLimit: number | null | undefined): string {
  if (containerMemoryLimit == null) return "Unknown";
  if (containerMemoryLimit === 0) return "No limit";
  return `${formatBytes(containerMemoryLimit)} limit`;
}

/**
 * The row's restart cue restated, or null when the row carries none either.
 * Built from the row's own note, so the two cannot drift apart.
 */
export function restartLine(count: number | null | undefined) {
  const note = restartNote(count);
  return note && { ...note, qualifier: "resets on deploy" };
}

/** `icon` mirrors the glyph on the app row, so this doubles as its legend. */
function Row({
  label,
  icon: Icon,
  iconClass,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  iconClass?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <dt className="flex w-16 shrink-0 items-center gap-1.5 text-muted-foreground">
        {Icon && <Icon className={`size-3 shrink-0 ${iconClass ?? "text-muted-foreground/70"}`} />}
        {label}
      </dt>
      <dd className="min-w-0 flex-1 break-words text-foreground/90">{children}</dd>
    </div>
  );
}

/** The context the row's status dot and icon strip encode, spelled out. */
export function AppRowCard({
  app,
  updateCount,
  usage,
}: {
  app: AppRowCardApp;
  updateCount: number;
  usage?: AppRowCardUsage;
}) {
  const deploy = app.deployments?.[0];
  const conditions = app.conditions ?? [];
  const domains = app.domains ?? [];
  const running = app.status === "active";
  const restarts = restartLine(app.restartCount);
  const tags = (app.appTags ?? []).map((t) => t.tag.name.toLowerCase());

  return (
    <div className="w-72 space-y-2.5 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate font-medium text-foreground">{app.displayName}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <span aria-hidden="true" className={`size-1.5 rounded-full ${statusDotColor(app.status)}`} />
          {STATUS_LABEL[app.status] ?? app.status}
        </span>
      </div>

      {/* The row's note, restated first — a card leading with a green Running
          while the row says deploy needed reads as a contradiction. */}
      {(conditions.length > 0 || app.needsRedeploy || restarts) && (
        <ul className="space-y-1 border-t pt-2">
          {conditions.map((c) => (
            <li key={c.kind} className="flex items-baseline justify-between gap-3">
              <span className={`shrink-0 font-medium ${conditionTone(c.severity)}`}>
                {conditionLabel(c)}
              </span>
              <span className="min-w-0 truncate text-right text-muted-foreground">
                {formatDistanceToNowStrict(new Date(c.since))}
              </span>
            </li>
          ))}
          {app.needsRedeploy && (
            <li className="flex items-baseline justify-between gap-3">
              <span className="shrink-0 font-medium text-status-warning">deploy needed</span>
              <span className="min-w-0 truncate text-right text-muted-foreground">
                config changed
              </span>
            </li>
          )}
          {restarts && (
            <li className="flex items-baseline justify-between gap-3">
              <span className={`shrink-0 font-medium ${restarts.tone}`}>{restarts.label}</span>
              <span className="min-w-0 truncate text-right text-muted-foreground">
                {restarts.qualifier}
              </span>
            </li>
          )}
        </ul>
      )}

      <dl className="space-y-1 border-t pt-2">
        {app.imageName && <Row label="Image">{app.imageName}</Row>}
        {app.containerStartedAt && (
          <Row label="Uptime">{formatDistanceToNowStrict(new Date(app.containerStartedAt))}</Row>
        )}
        {running && (
          <Row label="Usage">
            {readingLabel(usage?.cpuPercent, formatCores)} ·{" "}
            {readingLabel(usage?.memoryUsage, formatBytes)}
          </Row>
        )}
        <Row label="Memory">{memoryLimitLabel(app.containerMemoryLimit)}</Row>
        {deploy && (
          <Row label="Deployed">
            {formatDistanceToNowStrict(new Date(deploy.startedAt), { addSuffix: true })}
            {deploy.status === "failed" && <span className="text-status-error"> · failed</span>}
          </Row>
        )}
        {domains.length > 0 && <Row label="Domains">{domains.map((d) => d.domain).join(", ")}</Row>}
        {/* The row hides these on narrow containers; the card always carries them. */}
        {tags.length > 0 && <Row label="Tags">{tags.join(", ")}</Row>}
        {(app.dependsOn?.length ?? 0) > 0 && (
          <Row label="Depends">{app.dependsOn?.join(", ")}</Row>
        )}
        {updateCount > 0 && (
          <Row label="Updates" icon={Package} iconClass="text-status-update">
            {updateCount === 1 ? "1 image update" : `${updateCount} image updates`}
          </Row>
        )}
        {app.priority === "critical" && (
          <Row label="Priority" icon={ShieldCheck}>
            Critical
          </Row>
        )}
        {app.priority === "disposable" && (
          <Row label="Priority" icon={CircleDashed}>
            Disposable
          </Row>
        )}
        {app.gpuEnabled && (
          <Row label="GPU" icon={Cpu}>
            Passthrough enabled
          </Row>
        )}
      </dl>
    </div>
  );
}
