import { formatDistanceToNowStrict } from "date-fns";
import { Cpu, Package, ShieldCheck, Trash2, type LucideIcon } from "lucide-react";

import { formatBytes } from "@/lib/metrics/format";
import { statusDotColor } from "@/lib/ui/status-colors";
import { conditionLabel, conditionTone } from "@/lib/ui/conditions";
import type { AppCondition } from "@/lib/docker/conditions";

export type AppRowCardApp = {
  displayName: string;
  status: string;
  imageName: string | null;
  containerStartedAt: Date | null;
  containerMemoryLimit: number | null;
  priority: "critical" | "standard" | "disposable" | null;
  gpuEnabled: boolean | null;
  needsRedeploy: boolean | null;
  conditions: AppCondition[] | null;
  domains: { domain: string; isPrimary: boolean | null }[];
  deployments: { status: string; startedAt: Date }[];
};

const STATUS_LABEL: Record<string, string> = {
  active: "Running",
  stopped: "Stopped",
  error: "Crashed",
  deploying: "Deploying",
  missing: "No container",
};

/** Memory row label. null = never observed. 0 = observed and uncapped. */
export function memoryLimitLabel(containerMemoryLimit: number | null): string {
  if (containerMemoryLimit == null) return "Unknown";
  if (containerMemoryLimit === 0) return "No limit";
  return `${formatBytes(containerMemoryLimit)} limit`;
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
export function AppRowCard({ app, updateCount }: { app: AppRowCardApp; updateCount: number }) {
  const deploy = app.deployments[0];
  const conditions = app.conditions ?? [];

  return (
    <div className="w-72 space-y-2.5 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate font-medium text-foreground">{app.displayName}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <span aria-hidden="true" className={`size-1.5 rounded-full ${statusDotColor(app.status)}`} />
          {STATUS_LABEL[app.status] ?? app.status}
        </span>
      </div>

      {conditions.length > 0 && (
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
        </ul>
      )}

      <dl className="space-y-1 border-t pt-2">
        {app.imageName && <Row label="Image">{app.imageName}</Row>}
        {app.containerStartedAt && (
          <Row label="Uptime">{formatDistanceToNowStrict(new Date(app.containerStartedAt))}</Row>
        )}
        <Row label="Memory">{memoryLimitLabel(app.containerMemoryLimit)}</Row>
        {deploy && (
          <Row label="Deployed">
            {formatDistanceToNowStrict(new Date(deploy.startedAt), { addSuffix: true })}
            {deploy.status === "failed" && <span className="text-status-error"> · failed</span>}
          </Row>
        )}
        {app.domains.length > 0 && (
          <Row label="Domains">{app.domains.map((d) => d.domain).join(", ")}</Row>
        )}
        {updateCount > 0 && (
          <Row label="Updates" icon={Package}>
            {updateCount === 1 ? "1 image update" : `${updateCount} image updates`}
          </Row>
        )}
        {app.priority === "critical" && (
          <Row label="Priority" icon={ShieldCheck} iconClass="text-status-warning">
            Critical
          </Row>
        )}
        {app.priority === "disposable" && (
          <Row label="Priority" icon={Trash2} iconClass="text-muted-foreground/50">
            Disposable
          </Row>
        )}
        {app.gpuEnabled && (
          <Row label="GPU" icon={Cpu} iconClass="text-muted-foreground/50">
            Passthrough enabled
          </Row>
        )}
        {app.needsRedeploy && <Row label="Config">Changed since last deploy</Row>}
      </dl>
    </div>
  );
}
