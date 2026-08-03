// ---------------------------------------------------------------------------
// Instance infrastructure rows
//
// Vardo's own stack and the shared core services, as attention rows that every
// session sees regardless of the org it is scoped to. Pure: the database read
// lives in ./infrastructure.
// ---------------------------------------------------------------------------

import { isVardoStack } from "@/lib/api/system-managed";
import type { AppCondition, ConditionKind } from "@/lib/docker/conditions";
import { isCoreServiceApp } from "@/lib/infra/core-services";
import { probeAppName } from "@/lib/infra/instance-apps";
import type { AttentionItem, AttentionRow, AttentionTone } from "@/lib/ui/attention";
import type { ServiceDown } from "./service-alerts";

/** The row a client watches to know the console itself is being replaced. */
export const SELF_DEPLOY_ROW_KEY = "vardo-self-deploy";

/** Runtime conditions worth interrupting every page for. The rest are app-level detail. */
const REPORTED_CONDITIONS: ConditionKind[] = ["crash-looping", "unhealthy", "self-heal-exhausted"];

/** App statuses that mean the container is not doing its job. */
const BROKEN_STATUSES = ["error", "missing"];

export type InfraApp = {
  id: string;
  name: string;
  displayName: string;
  status: string;
  conditions: AppCondition[] | null;
};

export type InfraDeployment = {
  id: string;
  appId: string;
  gitSha: string | null;
  startedAt: Date;
};

export type InfrastructureSnapshot = {
  apps: InfraApp[];
  deployments: InfraDeployment[];
  servicesDown: ServiceDown[];
};

export type InfrastructureOptions = {
  /** Only app admins have a route to these apps; everyone else gets an unlinked row. */
  canLinkToAdmin: boolean;
};

type Issue = {
  id: string;
  name: string;
  detail: string;
  since?: string;
  tone: Exclude<AttentionTone, "neutral" | "activity">;
  core: boolean;
};

/** Whether a self-deploy is running, from rows that already crossed the wire. */
export function hasSelfDeploy(rows: AttentionRow[]): boolean {
  return rows.some((row) => row.key === SELF_DEPLOY_ROW_KEY && row.items.length > 0);
}

/**
 * Everything the instance needs to say about itself. Returns nothing on a
 * healthy instance — this renders on every page, so silence is the default.
 */
export function infrastructureRows(
  snapshot: InfrastructureSnapshot,
  { canLinkToAdmin }: InfrastructureOptions,
): AttentionRow[] {
  const byId = new Map(snapshot.apps.map((a) => [a.id, a]));
  const byName = new Map(snapshot.apps.map((a) => [a.name, a]));
  const adminHref = canLinkToAdmin ? "/admin" : undefined;
  const coreHref = canLinkToAdmin ? "/admin/settings/core-services" : undefined;

  const rows: AttentionRow[] = [];

  const selfDeploys: AttentionItem[] = [];
  const coreDeploys: AttentionItem[] = [];
  // Apps whose health is not evidence of anything right now. A stack deploy
  // replaces every container in it, so the whole stack goes quiet, not just the
  // row the deployment is attached to.
  const deploying = new Set<string>();

  for (const deployment of latestPerApp(snapshot.deployments)) {
    const app = byId.get(deployment.appId);
    if (!app) continue;
    for (const other of snapshot.apps) {
      if (other.id === app.id || (isVardoStack(app.name) && isVardoStack(other.name))) {
        deploying.add(other.id);
      }
    }
    const item: AttentionItem = {
      id: deployment.id,
      name: app.displayName,
      href: isVardoStack(app.name) ? adminHref : coreHref,
      detail: deployment.gitSha ? deployment.gitSha.slice(0, 7) : undefined,
      since: deployment.startedAt.toISOString(),
    };
    (isVardoStack(app.name) ? selfDeploys : coreDeploys).push(item);
  }

  if (selfDeploys.length > 0) {
    rows.push({
      key: SELF_DEPLOY_ROW_KEY,
      label: "Vardo updating",
      tone: "activity",
      items: selfDeploys,
      footer: "The console restarts when this finishes. This page reconnects on its own.",
    });
  }

  if (coreDeploys.length > 0) {
    rows.push({
      key: "core-service-updating",
      label: "Core service updating",
      tone: "activity",
      items: coreDeploys,
      footer: "Metrics, logs or error tracking may have gaps until it finishes.",
    });
  }

  // One issue per subject, alerts first: a probe failure is a better account of
  // an outage than the container status that follows from it.
  const issues = new Map<string, Issue>();

  for (const service of snapshot.servicesDown) {
    const appName = probeAppName(service.name);
    const app = appName ? byName.get(appName) : undefined;
    if (app && deploying.has(app.id)) continue;
    issues.set(app?.id ?? service.id, {
      id: app?.id ?? service.id,
      name: app?.displayName ?? service.name,
      detail: "Not responding",
      since: service.lastFired,
      tone: "error",
      core: isCoreServiceApp(appName ?? ""),
    });
  }

  for (const app of snapshot.apps) {
    if (deploying.has(app.id) || issues.has(app.id)) continue;
    const issue = appIssue(app);
    if (issue) issues.set(app.id, issue);
  }

  const grouped = [...issues.values()];
  pushIssueRow(rows, {
    key: "vardo-stack-degraded",
    label: "Vardo degraded",
    issues: grouped.filter((i) => !i.core),
    href: adminHref,
    footer: "Part of Vardo's own stack. The console may be unreliable until it recovers.",
  });
  pushIssueRow(rows, {
    key: "core-service-down",
    label: "Core service down",
    issues: grouped.filter((i) => i.core),
    href: coreHref,
    footer: "Platform services Vardo depends on. Metrics, logs or error tracking will have gaps.",
  });

  return rows;
}

/** Most recent deployment per app, so a requeued deploy is still one subject. */
function latestPerApp(deployments: InfraDeployment[]): InfraDeployment[] {
  const latest = new Map<string, InfraDeployment>();
  for (const deployment of deployments) {
    const held = latest.get(deployment.appId);
    if (!held || held.startedAt < deployment.startedAt) latest.set(deployment.appId, deployment);
  }
  return [...latest.values()];
}

function appIssue(app: InfraApp): Issue | null {
  const core = isCoreServiceApp(app.name);

  const condition = (app.conditions ?? [])
    .filter((c) => REPORTED_CONDITIONS.includes(c.kind))
    .sort((a, b) => severityRank(a) - severityRank(b))[0];

  if (condition) {
    return {
      id: app.id,
      name: app.displayName,
      detail: condition.detail,
      since: condition.since,
      tone: condition.severity === "critical" ? "error" : "warning",
      core,
    };
  }

  if (BROKEN_STATUSES.includes(app.status)) {
    return {
      id: app.id,
      name: app.displayName,
      detail: app.status === "missing" ? "No container on the host" : "Container failed",
      tone: "error",
      core,
    };
  }

  return null;
}

function severityRank(condition: AppCondition): number {
  return condition.severity === "critical" ? 0 : condition.severity === "warning" ? 1 : 2;
}

function pushIssueRow(
  rows: AttentionRow[],
  spec: { key: string; label: string; issues: Issue[]; href?: string; footer: string },
): void {
  if (spec.issues.length === 0) return;
  rows.push({
    key: spec.key,
    label: spec.label,
    tone: spec.issues.some((i) => i.tone === "error") ? "error" : "warning",
    items: spec.issues.map((i) => ({
      id: i.id,
      name: i.name,
      href: spec.href,
      detail: i.detail,
      since: i.since,
    })),
    footer: spec.footer,
  });
}
