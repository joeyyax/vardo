import type { StatusDotTone } from "@/components/ui/status-dot";
import { problem, type ProblemSubject } from "@/lib/ui/conditions";

export type StatusMarkState = { tone: StatusDotTone; pending: boolean; label: string };

const RUNNING: StatusMarkState = { tone: "good", pending: false, label: "Running" };
const DEPLOYING: StatusMarkState = { tone: "info", pending: true, label: "Deploying" };
const ATTENTION: StatusMarkState = { tone: "warn", pending: false, label: "Needs attention" };
const FAILED: StatusMarkState = { tone: "issue", pending: false, label: "Failed" };
const STOPPED: StatusMarkState = { tone: "stopped", pending: false, label: "Stopped" };

const MARK_RANK: Record<string, number> = { Failed: 3, "Needs attention": 2, Deploying: 1, Running: 0 };

function ownMark(app: ProblemSubject): StatusMarkState {
  const p = problem(app);
  if (p?.tone === "error") return FAILED;
  if (p) return ATTENTION;
  if (app.status === "deploying") return DEPLOYING;
  return RUNNING;
}

/**
 * The status mark for an app. A parent shows the worst state inside it, so a folded row never
 * looks healthier than it is. Stopped on purpose wins over everything below it.
 */
export function statusMarkTone(app: ProblemSubject & { children?: ProblemSubject[] }): StatusMarkState {
  if (app.parked || app.status === "stopped") return STOPPED;
  let worst = ownMark(app);
  for (const child of app.children ?? []) {
    if (child.parked || child.status === "stopped") continue;
    const mark = statusMarkTone(child);
    if (MARK_RANK[mark.label] > MARK_RANK[worst.label]) worst = mark;
  }
  return worst;
}

/** Runtime health dot color. */
export function statusDotColor(status: string) {
  return status === "active"
    ? "bg-status-success"
    : status === "error"
      ? "bg-status-error"
      : status === "deploying"
        ? "bg-status-info"
        : status === "missing"
          ? "bg-status-warning"
          : "bg-status-neutral";
}

/** Environment tier dot: solid production, half staging, hollow ephemeral. */
export function envTypeDotColor(type: string) {
  return type === "production"
    ? "bg-env-tier"
    : type === "staging"
      ? "bg-env-tier/60 ring-1 ring-inset ring-env-tier"
      : "bg-env-tier-muted ring-1 ring-inset ring-env-tier";
}
