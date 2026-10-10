import type { StatusMarkState } from "@/lib/ui/status-colors";
import { extractDeployError } from "@/lib/ui/deploy-error";

/** The window the Deployments stats count over. */
export const DEPLOY_WINDOW_DAYS = 7;
const WINDOW_MS = DEPLOY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type DeployFilter = "failed" | "rollbacks";

export function isDeployFilter(value: string | null | undefined): value is DeployFilter {
  return value === "failed" || value === "rollbacks";
}

/** Where a deploy sits on the tab. */
export type DeployRole = "live" | "standby" | "history" | "queued";

export type DeployRowInput = {
  status: string;
  trigger: string;
  log: string | null;
  postDeployError: string | null;
  startedAt: Date | string;
};

/** Rolled back by health checks, or a rebuild of an earlier deploy. */
export function isRollback(d: Pick<DeployRowInput, "status" | "trigger">): boolean {
  return d.status === "rolled_back" || d.trigger === "rollback";
}

function inWindow(d: Pick<DeployRowInput, "startedAt">, now: number): boolean {
  return now - new Date(d.startedAt).getTime() <= WINDOW_MS;
}

export function matchesDeployFilter(d: DeployRowInput, filter: DeployFilter, now: number): boolean {
  if (!inWindow(d, now)) return false;
  return filter === "failed" ? d.status === "failed" : isRollback(d);
}

/** Failed deploys and rollbacks in the window. */
export function deployCounts(deploys: DeployRowInput[], now: number): Record<DeployFilter, number> {
  return {
    failed: deploys.filter((d) => matchesDeployFilter(d, "failed", now)).length,
    rollbacks: deploys.filter((d) => matchesDeployFilter(d, "rollbacks", now)).length,
  };
}

const mark = (tone: StatusMarkState["tone"], label: string, pending = false): StatusMarkState => ({ tone, label, pending });

/** The row's mark. Only problems carry color; past releases are quiet. */
export function deployMark(d: DeployRowInput, role: DeployRole, appStatus: string): StatusMarkState {
  if (role === "queued") return mark("neutral", "Queued", true);
  if (d.status === "running") return mark("info", "Deploying", true);
  if (role === "live") {
    if (appStatus === "error") return mark("issue", "Crashed");
    if (appStatus === "stopped") return mark("stopped", "Stopped");
    if (d.postDeployError) return mark("warn", "Post-deploy incomplete");
    return appStatus === "active" || appStatus === "deploying" ? mark("good", "Live") : mark("neutral", "Deployed");
  }
  if (role === "standby") return mark("neutral", "Standby");
  if (d.status === "failed") return mark("issue", "Failed");
  if (d.status === "rolled_back") return mark("warn", "Rolled back");
  if (d.status === "cancelled") return mark("stopped", "Cancelled");
  if (d.postDeployError) return mark("warn", "Post-deploy incomplete");
  return mark("neutral", "Superseded");
}

/** What went wrong, for a row that has a problem. Null when nothing did. */
export function deployProblem(d: DeployRowInput, role: DeployRole, appStatus: string): { text: string; tone: "error" | "warning" } | null {
  if (d.status === "failed") return { text: extractDeployError(d.log) ?? "Failed", tone: "error" };
  if (role === "live" && appStatus === "error") return { text: extractDeployError(d.log) ?? "Crashed", tone: "error" };
  if (d.status === "rolled_back") return { text: "Rolled back", tone: "warning" };
  if (d.postDeployError) return { text: "Post-deploy incomplete", tone: "warning" };
  return null;
}

export function triggerLabel(trigger: string): string {
  return (
    { manual: "Manual deploy", webhook: "Auto deploy", api: "API deploy", rollback: "Rollback", relay: "Relayed deploy", poll: "Polled deploy" }[trigger] ??
    `${trigger.charAt(0).toUpperCase()}${trigger.slice(1)} deploy`
  );
}
