import { formatDistanceToNowStrict } from "date-fns";

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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
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
        <Row label="Memory">
          {app.containerMemoryLimit ? `${formatBytes(app.containerMemoryLimit)} limit` : "No limit"}
        </Row>
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
          <Row label="Updates">
            {updateCount === 1 ? "1 image update" : `${updateCount} image updates`}
          </Row>
        )}
        {app.priority && app.priority !== "standard" && (
          <Row label="Priority">{app.priority === "critical" ? "Critical" : "Disposable"}</Row>
        )}
        {app.gpuEnabled && <Row label="GPU">Passthrough enabled</Row>}
        {app.needsRedeploy && <Row label="Config">Changed since last deploy</Row>}
      </dl>
    </div>
  );
}
