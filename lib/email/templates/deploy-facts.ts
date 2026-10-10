import type { DeployDetails } from "@/lib/bus/events";
import { TIMED_PHASES, type StageTimings, type TimedPhase } from "@/lib/docker/stage-timings";
import { commitUrl, formatDuration, shortSha, triggerLabel } from "../format";
import type { MailFact, MailVisual } from "./components";

type DeployFactInput = DeployDetails & {
  domain?: string;
  gitSha?: string;
  gitMessage?: string;
  triggeredBy?: string;
};

/** Where the app lives: project, environment and domains. */
export function placeFacts(event: DeployFactInput): MailFact[] {
  const facts: MailFact[] = [];
  if (event.project) facts.push({ label: "Project", value: event.project });
  if (event.environment) facts.push({ label: "Environment", value: event.environment });
  const domains = event.domains?.length ? event.domains : event.domain ? [event.domain] : [];
  for (const [index, domain] of domains.slice(0, 5).entries()) {
    facts.push({ label: index === 0 ? (domains.length > 1 ? "Domains" : "Domain") : "", value: domain, href: `https://${domain}` });
  }
  if (domains.length > 5) facts.push({ label: "", value: `and ${domains.length - 5} more` });
  return facts;
}

/** What shipped: commit, author, branch and trigger. */
export function changeFacts(event: DeployFactInput): MailFact[] {
  const facts: MailFact[] = [];
  if (event.gitSha) {
    const message = event.gitMessage ? ` ${event.gitMessage}` : "";
    facts.push({ label: "Commit", value: `${shortSha(event.gitSha)}${message}`, href: commitUrl(event.repoUrl, event.gitSha) });
  }
  if (event.gitAuthor) facts.push({ label: "Author", value: event.gitAuthor });
  if (event.gitBranch) facts.push({ label: "Branch", value: event.gitBranch, mono: true });
  const trigger = triggerLabel(event.trigger, event.triggeredBy);
  if (trigger) facts.push({ label: "Trigger", value: trigger });
  return facts;
}

const PHASE_LABEL: Record<TimedPhase, string> = {
  clone: "Clone",
  build: "Build",
  export: "Export",
  pull: "Pull",
  up: "Start",
  healthWait: "Health wait",
  cleanup: "Cleanup",
};

/** Deploy stage to the timed phases it covers. */
const STAGE_PHASES: Record<string, TimedPhase[]> = {
  clone: ["clone"],
  build: ["build", "export"],
  deploy: ["pull", "up"],
  healthcheck: ["healthWait"],
  routing: ["cleanup"],
  cleanup: ["cleanup"],
};

/** Phase timings as a stacked bar, ending at a failed deploy's failing phase in red. */
export function phaseVisual(
  timings: StageTimings | undefined,
  failedStage?: string,
  opts: { totalMs?: number; caption?: boolean } = {},
): MailVisual | undefined {
  if (!timings) return undefined;
  let phases = TIMED_PHASES.filter((p) => (timings[p]?.ms ?? 0) > 0);
  const covered = failedStage ? (STAGE_PHASES[failedStage] ?? []) : [];
  if (phases.length === 0 || (phases.length < 2 && covered.length === 0)) return undefined;

  const ms = (p: TimedPhase) => timings[p]?.ms ?? 0;
  let failedAt = -1;
  let untimed: { phase: TimedPhase; ms: number } | null = null;
  if (covered.length) {
    failedAt = phases.findLastIndex((p) => covered.includes(p));
    if (failedAt === -1) {
      // The failing phase never reported a time; it gets the untimed remainder.
      const start = TIMED_PHASES.indexOf(covered[0]);
      phases = phases.filter((p) => TIMED_PHASES.indexOf(p) < start);
      const timed = phases.reduce((sum, p) => sum + ms(p), 0);
      untimed = { phase: covered[0], ms: Math.max(opts.totalMs !== undefined ? opts.totalMs - timed : 0, 1) };
      failedAt = phases.length;
    } else {
      phases = phases.slice(0, failedAt + 1);
    }
  }

  const segments = phases.map((p, i) => ({
    label: PHASE_LABEL[p],
    value: ms(p),
    detail: formatDuration(ms(p)),
    tone: i === failedAt ? ("fail" as const) : ((i % 4) as 0 | 1 | 2 | 3),
  }));
  if (untimed) {
    segments.push({
      label: PHASE_LABEL[untimed.phase],
      value: untimed.ms,
      detail: untimed.ms > 1 ? formatDuration(untimed.ms) : "untimed",
      tone: "fail",
    });
  }
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const failed = failedAt !== -1;
  return {
    kind: "stacked",
    title: failed ? "Where the time went" : "Phases",
    segments,
    caption: opts.caption === false ? undefined : `${formatDuration(total)} timed${failed ? ", stopped at the red phase" : ""}`,
  };
}
