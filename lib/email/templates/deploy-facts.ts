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

/** Phase timings as a stacked bar. A failed deploy's bar ends at its failing phase, in red. */
export function phaseVisual(timings: StageTimings | undefined, failedStage?: string): MailVisual | undefined {
  if (!timings) return undefined;
  let phases = TIMED_PHASES.filter((p) => (timings[p]?.ms ?? 0) > 0);
  if (phases.length === 0 || (phases.length < 2 && !failedStage)) return undefined;

  let failedAt = -1;
  if (failedStage) {
    const covered = STAGE_PHASES[failedStage] ?? [];
    failedAt = phases.findLastIndex((p) => covered.includes(p));
    if (failedAt === -1) failedAt = phases.length - 1;
    phases = phases.slice(0, failedAt + 1);
  }

  const ms = (p: TimedPhase) => timings[p]?.ms ?? 0;
  const total = phases.reduce((sum, p) => sum + ms(p), 0);
  return {
    kind: "stacked",
    title: failedStage ? "Where the time went" : "Phases",
    segments: phases.map((p, i) => ({
      label: PHASE_LABEL[p],
      value: ms(p),
      detail: formatDuration(ms(p)),
      tone: i === failedAt ? "fail" : ((i % 4) as 0 | 1 | 2 | 3),
    })),
    caption: `${formatDuration(total)} timed${failedStage ? ", stopped at the red phase" : ""}`,
  };
}
