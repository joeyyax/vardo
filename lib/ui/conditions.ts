import {
  BACKUP_NEVER_RAN_DETAIL,
  worstCondition,
  type AppCondition,
  type ConditionSeverity,
} from "@/lib/docker/conditions";
import type { ExitReason } from "@/lib/docker/exit-reason";
import { exitReasonShort } from "@/lib/ui/exit-reason";

/** Short form for list rows. */
export function conditionLabel(c: AppCondition): string {
  switch (c.kind) {
    case "crash-looping":
      return "crash looping";
    case "self-heal-exhausted":
      return "restarts exhausted";
    case "unhealthy":
      return "unhealthy";
    case "memory-pressure": {
      const pct = c.detail.match(/^(\d+)%/)?.[1];
      return pct ? `${pct}% memory` : "memory pressure";
    }
    case "security-findings": {
      const n = c.detail.match(/^(\d+)/)?.[1];
      return c.severity === "critical" ? `${n ?? ""} critical`.trim() : `${n ?? ""} warnings`.trim();
    }
    case "backup-missing":
      return "no backup";
    case "backup-stale":
      return "backup overdue";
    case "cert-expiring":
      return "cert expiring";
    case "cert-expired":
      return "cert expired";
  }
}

/** Precise labels for each backup problem, shared by every source that reports one. */
export const BACKUP_TITLE = {
  failed: "Backup failed",
  overdue: "Overdue",
  never: "Never backed up",
  uncovered: "Not covered by a backup job",
  paused: "Paused",
} as const;

/** What one condition says is wrong, as an item label. */
export function conditionTitle(c: AppCondition): string {
  switch (c.kind) {
    case "crash-looping":
      return "Crash looping";
    case "self-heal-exhausted":
      return "Restarts exhausted";
    case "unhealthy":
      return "Health check failing";
    case "memory-pressure":
      return `Memory at ${conditionLabel(c).replace(" memory", "")}`;
    case "security-findings":
      return "Security findings";
    case "backup-missing":
      return BACKUP_TITLE.uncovered;
    case "backup-stale":
      return c.detail === BACKUP_NEVER_RAN_DETAIL ? BACKUP_TITLE.never : BACKUP_TITLE.overdue;
    case "cert-expiring":
      return "Certificate expiring";
    case "cert-expired":
      return "Certificate expired";
  }
}

/** The app tab that explains a condition. */
export function conditionHref(appName: string, kind: AppCondition["kind"]): string {
  switch (kind) {
    case "crash-looping":
    case "self-heal-exhausted":
    case "unhealthy":
      return `/apps/${appName}/stability`;
    case "memory-pressure":
      return `/apps/${appName}/metrics`;
    case "security-findings":
      return `/apps/${appName}/security`;
    case "backup-missing":
    case "backup-stale":
      return `/apps/${appName}/backups`;
    case "cert-expiring":
    case "cert-expired":
      return `/apps/${appName}/networking`;
  }
}

export function conditionTone(severity: ConditionSeverity): string {
  return severity === "critical"
    ? "text-status-error"
    : severity === "warning"
      ? "text-status-warning"
      : "text-muted-foreground";
}

/** Apps needing attention, for a project-level rollup. */
export function countNeedingAttention(
  apps: { conditions?: AppCondition[] | null }[],
): { critical: number; warning: number } {
  let critical = 0;
  let warning = 0;
  for (const a of apps) {
    const worst = a.conditions?.reduce<AppCondition | null>(
      (w, c) => (!w || (c.severity === "critical" && w.severity !== "critical") ? c : w),
      null,
    );
    if (!worst) continue;
    if (worst.severity === "critical") critical++;
    else if (worst.severity === "warning") warning++;
  }
  return { critical, warning };
}

// --- Problems ---------------------------------------------------------------

export type ProblemGroup =
  | "vardo"
  | "crash"
  | "failed"
  | "missing"
  | "domains"
  | "health"
  | "memory"
  | "errors"
  | "backups"
  | "certs"
  | "security"
  | "config";

/** A fix the console runs in place, or a page that handles it. */
export type FixAction =
  | { label: string; run: "deploy" | "restart" | "backup" }
  | { label: string; href: string };

export type Problem = {
  group: ProblemGroup;
  tone: "error" | "warning";
  title: string;
  detail: string;
  /** ISO time the problem began, when known. */
  since: string | null;
  /** Null when only a person can fix it. */
  fix: FixAction | null;
  /** Where to look. */
  look: { label: string; href: string };
};

/** What problem() reads. */
export type ProblemSubject = {
  name: string;
  status: string;
  parked?: boolean | null;
  conditions?: AppCondition[] | null;
  exitReason?: ExitReason | null;
  needsRedeploy?: boolean | null;
  latestDeploy?: { status: string; startedAt: Date | string } | null;
  /** When the container was last seen running. */
  lastRunningAt?: Date | string | null;
  statusChangedAt?: Date | string | null;
  /** Status of the compose parent, for a service. */
  parentStatus?: string | null;
  /** Services under a compose parent. */
  serviceCount?: number;
};

export type ProblemGroupMeta = {
  title: string;
  /** One line on what the group means. */
  why: string;
  /** Label for fixing every item at once, when one action fits them all. */
  bulk: string | null;
};

export const PROBLEM_GROUPS: Record<ProblemGroup, ProblemGroupMeta> = {
  vardo: { title: "Vardo", why: "Vardo's own stack and the services it runs on.", bulk: null },
  crash: { title: "Crash looping", why: "Restarting over and over. The logs usually say why.", bulk: null },
  failed: { title: "Failed or crashed", why: "The last deploy or the running container failed.", bulk: "Retry" },
  missing: {
    title: "No container",
    why: "Vardo expects these to run, but Docker has no container for them.",
    bulk: "Deploy",
  },
  domains: { title: "Unreachable domains", why: "The last check for these domains failed.", bulk: null },
  health: { title: "Failing health checks", why: "Running, but the image's own health check fails.", bulk: null },
  memory: {
    title: "Memory pressure",
    why: "Close to the memory limit. At the limit the container is killed.",
    bulk: null,
  },
  errors: { title: "Errors up", why: "Logging errors far faster than usual.", bulk: null },
  backups: { title: "Backups", why: "Volumes without a recent good backup.", bulk: "Back up" },
  certs: { title: "Certificates", why: "Renewal runs on its own. These haven't renewed yet.", bulk: null },
  security: { title: "Security findings", why: "The image scan found issues to review.", bulk: null },
  config: { title: "Deploy needed", why: "Settings changed since the last deploy.", bulk: "Deploy" },
};

/** Worst first. */
export const PROBLEM_GROUP_ORDER: ProblemGroup[] = [
  "vardo",
  "crash",
  "failed",
  "missing",
  "domains",
  "health",
  "memory",
  "errors",
  "backups",
  "certs",
  "security",
  "config",
];

const toIso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : typeof d === "string" ? d : d.toISOString();

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The problem one condition describes. */
export function conditionProblem(appName: string, c: AppCondition): Problem {
  const tone = c.severity === "critical" ? "error" : "warning";
  const look = (label: string) => ({ label, href: conditionHref(appName, c.kind) });
  const detail = c.kind === "backup-missing" ? "" : sentence(c.detail);
  const base = { tone, detail, since: c.since } as const;
  const backup = { label: "Back up now", run: "backup" } as const;
  const restart = { label: "Restart", run: "restart" } as const;
  const title = conditionTitle(c);
  switch (c.kind) {
    case "crash-looping":
    case "self-heal-exhausted":
      return { ...base, group: "crash", title, fix: restart, look: look("View logs") };
    case "unhealthy":
      return { ...base, group: "health", title, fix: null, look: look("View logs") };
    case "memory-pressure":
      return { ...base, group: "memory", title, fix: null, look: look("Adjust limit") };
    case "security-findings":
      return { ...base, group: "security", title, fix: null, look: look("Review") };
    case "backup-missing":
    case "backup-stale":
      return { ...base, group: "backups", title, fix: backup, look: look("Backups") };
    case "cert-expiring":
    case "cert-expired":
      return { ...base, group: "certs", title, fix: null, look: look("Networking") };
  }
}

/**
 * The one problem worth naming for an app: what happened, since when and the fix.
 * Shared by list rows, the detail panel and the attention bar. Null when healthy or stopped on purpose.
 */
export function problem(app: ProblemSubject): Problem | null {
  if (app.parked) return null;
  const conditions = app.conditions ?? [];
  // A service in its parent's state is the parent's problem.
  if (app.parentStatus && app.status === app.parentStatus && conditions.length === 0) return null;

  const logs = { label: "View logs", href: `/apps/${app.name}/logs` };
  const exit = app.exitReason ? sentence(exitReasonShort(app.exitReason)) : "";

  if (app.latestDeploy?.status === "failed") {
    return {
      group: "failed",
      tone: "error",
      title: "Deploy failed",
      detail: exit || (app.status === "active" ? "The previous version is still running" : "Health check failed"),
      since: toIso(app.latestDeploy.startedAt),
      fix: { label: "Retry deploy", run: "deploy" },
      look: { label: "Deploy log", href: `/apps/${app.name}/deployments` },
    };
  }
  if (app.status === "error") {
    return {
      group: "failed",
      tone: "error",
      title: "Crashed",
      detail: exit,
      since: app.exitReason?.at ?? toIso(app.statusChangedAt),
      fix: { label: "Restart", run: "restart" },
      look: logs,
    };
  }
  const worst = worstCondition(conditions);
  if (worst?.severity === "critical") return conditionProblem(app.name, worst);
  if (app.status === "missing") {
    const scope = app.serviceCount ? `All ${app.serviceCount} services. ` : "";
    return {
      group: "missing",
      tone: "warning",
      title: "No container",
      detail: scope + (exit || "Not running"),
      since: toIso(app.lastRunningAt) ?? toIso(app.statusChangedAt),
      fix: { label: "Deploy", run: "deploy" },
      look: logs,
    };
  }
  if (worst) {
    const problems = conditions.map((c) => conditionProblem(app.name, c));
    problems.sort((a, b) => PROBLEM_GROUP_ORDER.indexOf(a.group) - PROBLEM_GROUP_ORDER.indexOf(b.group));
    return problems[0];
  }
  if (app.needsRedeploy) {
    return {
      group: "config",
      tone: "warning",
      title: "Deploy needed",
      detail: "Settings changed since the last deploy",
      since: null,
      fix: { label: "Deploy", run: "deploy" },
      look: { label: "Settings", href: `/apps/${app.name}/settings` },
    };
  }
  return null;
}

/** Higher is worse. Errors outrank warnings; the group order breaks ties. */
export function problemRank(p: Problem | null): number {
  if (!p) return 0;
  return (p.tone === "error" ? 100 : 50) - PROBLEM_GROUP_ORDER.indexOf(p.group);
}
