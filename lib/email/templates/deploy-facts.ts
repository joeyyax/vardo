import type { DeployDetails } from "@/lib/bus/events";
import { knownFailure } from "@/lib/git-integration/deploy-failure";
import { TIMED_PHASES, type StageTimings, type TimedPhase } from "@/lib/docker/stage-timings";
import { commitUrl, formatDuration, shortSha, triggerLabel } from "../format";
import { linkedList, nameLink, type MailFact, type MailInline, type MailLink, type MailRich, type PhaseStep } from "./components";
import type { MailContext } from "./context";

type DeployFactInput = DeployDetails & {
  domain?: string;
  gitSha?: string;
  gitMessage?: string;
  triggeredBy?: string;
};

export function domainsOf(event: { domains?: string[]; domain?: string }): string[] {
  return event.domains?.length ? event.domains : event.domain ? [event.domain] : [];
}

export function projectPage(ctx: MailContext, projectId: string): string {
  return `${ctx.baseUrl}/projects/${projectId}`;
}

/** "Shop · production", the project linked. */
export function projectFact(event: { project?: string; projectId?: string; environment?: string }, ctx: MailContext): MailFact[] {
  if (!event.project) return [];
  const env = event.environment ? ` · ${event.environment}` : "";
  const href = event.projectId ? projectPage(ctx, event.projectId) : undefined;
  return [{ label: "Project", value: `${event.project}${env}`, rich: [nameLink(event.project, href), env] }];
}

const MAX_DOMAINS = 5;

export function domainsFact(event: DeployFactInput): MailFact[] {
  const domains = domainsOf(event);
  if (!domains.length) return [];
  const shown = domains.slice(0, MAX_DOMAINS);
  const more = domains.length > MAX_DOMAINS ? `, and ${domains.length - MAX_DOMAINS} more` : "";
  const rich: MailInline[] = [...linkedList(shown.map((d) => ({ text: d, href: `https://${d}` }))), more];
  return [{ label: domains.length > 1 ? "Domains" : "Domain", value: `${shown.join(", ")}${more}`, rich }];
}

const GIT_TRIGGERS = new Set(["webhook", "relay", "poll"]);

/** "Alex Kim, pushed to main" for a push; else the trigger. */
export function triggerFact(event: DeployFactInput): MailFact[] {
  if (event.gitAuthor && event.trigger && GIT_TRIGGERS.has(event.trigger)) {
    const branch = event.gitBranch ? ` to ${event.gitBranch}` : "";
    return [{ label: "Author", value: `${event.gitAuthor}, pushed${branch}` }];
  }
  const trigger = triggerLabel(event.trigger, event.triggeredBy)?.replace(/ by /, ", by ");
  return trigger ? [{ label: "Trigger", value: trigger }] : [];
}

/** The short SHA linked to the repo, then the commit subject. */
export function commitInline(event: { gitSha?: string; gitMessage?: string; repoUrl?: string }): MailInline[] {
  if (!event.gitSha) return [];
  const sha = nameLink(shortSha(event.gitSha), commitUrl(event.repoUrl, event.gitSha));
  return event.gitMessage ? [sha, ` ${event.gitMessage}`] : [sha];
}

export function commitFact(event: DeployFactInput): MailFact[] {
  if (!event.gitSha) return [];
  const value = `${shortSha(event.gitSha)}${event.gitMessage ? ` ${event.gitMessage}` : ""}`;
  return [{ label: "Commit", value, rich: commitInline(event) }];
}

const PHASE_LABEL: Record<TimedPhase, string> = {
  clone: "Clone",
  build: "Build",
  export: "Export",
  pull: "Pull",
  up: "Start",
  healthWait: "Health",
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

/** Phase timings in order, ending at a failed deploy's failing phase. */
export function phaseSteps(timings: StageTimings | undefined, failedStage?: string, totalMs?: number): PhaseStep[] | undefined {
  if (!timings) return undefined;
  const ms = (p: TimedPhase) => timings[p]?.ms ?? 0;
  let phases = TIMED_PHASES.filter((p) => ms(p) > 0);
  const covered = failedStage ? (STAGE_PHASES[failedStage] ?? []) : [];
  if (phases.length === 0 || (phases.length < 2 && covered.length === 0)) return undefined;

  const step = (p: TimedPhase, value = ms(p), failed = false): PhaseStep => ({
    label: PHASE_LABEL[p],
    value,
    detail: value > 1 ? formatDuration(value) : "untimed",
    ...(failed ? { failed } : {}),
  });
  if (!covered.length) return phases.map((p) => step(p));

  const failedAt = phases.findLastIndex((p) => covered.includes(p));
  if (failedAt !== -1) return phases.slice(0, failedAt + 1).map((p, i) => step(p, ms(p), i === failedAt));

  // The failing phase never reported a time; it gets the untimed remainder.
  const start = TIMED_PHASES.indexOf(covered[0]);
  phases = phases.filter((p) => TIMED_PHASES.indexOf(p) < start);
  const timed = phases.reduce((sum, p) => sum + ms(p), 0);
  const rest = Math.max(totalMs !== undefined ? totalMs - timed : 0, 1);
  return [...phases.map((p) => step(p)), step(covered[0], rest, true)];
}

export type FailureCause = { title: string; body?: MailRich; action?: MailLink };

const CRASHED = /did not become healthy: (\S+) crashed \(([^)]*)\)/;
const UNHEALTHY = /did not become healthy: (\S+) healthcheck reports unhealthy after (\d+)s/;
const STARTING = /^(\S+) is still starting after (\d+)s/;
const BUILD_STEP = /ERROR: process "(?:\/bin\/(?:ba)?sh -c )?(.+?)" did not complete successfully: exit code: (\d+)/;

/** The command a BuildKit step ran, without its flags: "composer install". */
export function stepName(command: string): string {
  const words: string[] = [];
  for (const word of command.trim().split(/\s+/)) {
    if (word.startsWith("-") || /^(&&|\|\||;|\|)$/.test(word) || words.length === 3) break;
    words.push(word);
  }
  return words.join(" ") || command;
}

/** The first line of a raw error, without the log pointer. */
export function firstLine(raw: string): string {
  return raw.split("\n")[0].replace(/\.?\s*See logs above\.?$/, ".").trim();
}

/** One plain sentence for why a deploy failed, from its error and log. Falls back to the raw first line. */
export function failureCause(event: {
  errorMessage?: string;
  message: string;
  failedStage?: string;
  crashReason?: string;
  logTail?: string[];
  gitSha?: string;
  gitMessage?: string;
  repoUrl?: string;
}): FailureCause {
  const raw = event.errorMessage || event.message;
  const inLog = (line: string) => event.logTail?.some((l) => l.includes(line)) ?? false;
  const crashLine: MailRich | undefined = event.crashReason && !inLog(event.crashReason) ? [{ text: event.crashReason, mono: true }] : undefined;

  const crashed = raw.match(CRASHED);
  if (crashed) {
    const restarts = crashed[2].match(/(\d+) restarts?/);
    const gaveUp = restarts ? `It restarted ${restarts[1]} times before Vardo gave up.` : undefined;
    const body: MailInline[] = [...(crashLine ?? []), crashLine && gaveUp ? " " : "", gaveUp ?? ""].filter(Boolean);
    return { title: `${crashed[1]} crashed on start`, body: body.length ? body : undefined };
  }
  const unhealthy = raw.match(UNHEALTHY);
  if (unhealthy) {
    return { title: `${unhealthy[1]} stayed unhealthy`, body: `Its health check was still failing after ${formatDuration(Number(unhealthy[2]) * 1000)}.` };
  }
  const starting = raw.match(STARTING);
  if (starting) {
    return {
      title: `${starting[1]} was still starting when the health check ran out of time`,
      body: `It ran ${formatDuration(Number(starting[2]) * 1000)} with no restarts, still logging. Raise the health check timeout in the app's settings or give it a healthcheck with a start_period.`,
    };
  }

  if (event.failedStage === "build") {
    const step = event.logTail?.map((l) => l.match(BUILD_STEP)).findLast(Boolean);
    const commit = commitInline(event);
    const action = event.gitSha && event.repoUrl ? { label: "Open the commit", href: commitUrl(event.repoUrl, event.gitSha)! } : undefined;
    if (step) {
      const body = commit.length ? [...commit, ` didn't build. The step exited with code ${step[2]}.`] : `The step exited with code ${step[2]}.`;
      return { title: `${stepName(step[1])} failed`, body, action };
    }
    return { title: knownFailure(raw) ?? firstLine(raw), body: commit.length ? commit : undefined, action };
  }

  return { title: knownFailure(raw) ?? firstLine(raw), body: crashLine };
}
