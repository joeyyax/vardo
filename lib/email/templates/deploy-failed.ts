import type { DeployFailedEvent } from "@/lib/bus/events";
import { formatDuration } from "../format";
import { appLabel, stageLabel } from "../subjects";
import type { MailBlock, MailFact, MailLink, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";
import { commitFact, failureCause, phaseSteps, projectFact, triggerFact } from "./deploy-facts";

const SERVING_LINE: Record<NonNullable<DeployFailedEvent["serving"]>, string> = {
  previous: "The previous version is still serving.",
  new: "The new version passed its health check and is serving.",
  none: "Nothing is serving this app right now.",
};

/** The reassurance line, or what's wrong when nothing serves. */
export function servingBlock(serving: DeployFailedEvent["serving"]): MailBlock | undefined {
  if (!serving) return undefined;
  if (serving === "none") return { kind: "text", text: SERVING_LINE.none };
  return { kind: "reassure", strong: "Nothing is down.", text: SERVING_LINE[serving] };
}

/** Vardo's own error lines repeat the callout. */
const OWN_ERROR = /^\[deploy\] ERROR:/;
const STAMP = /\d{4}-\d\d-\d\dT[\d:.]+Z?\s*/g;

/** A crash loop's last cycle: the lines after the previous copy of the final line. */
export function lastCycle(lines: string[]): string[] {
  const key = (line: string) => line.replace(STAMP, "").trim();
  const last = key(lines.at(-1) ?? "");
  const previous = lines.slice(0, -1).findLastIndex((line) => key(line) === last);
  return previous === -1 || previous > lines.length - 3 ? lines : lines.slice(previous + 1);
}

export function deployFailedMail(event: DeployFailedEvent, ctx: MailContext): NotificationMailBody {
  const name = appLabel(event);
  const stage = stageLabel(event.failedStage);
  const cause = failureCause(event);
  const commitShown = event.failedStage === "build" && !!event.gitSha;

  const blocks: MailBlock[] = [];
  const serving = servingBlock(event.serving);
  if (serving) blocks.push(serving);
  blocks.push({ kind: "callout", tone: "bad", ...cause });
  const steps = phaseSteps(event.stageTimings, event.failedStage, event.durationMs);
  if (steps) blocks.push({ kind: "section", title: "Where the time went" }, { kind: "phases", steps });
  const log = lastCycle((event.logTail ?? []).filter((line) => !OWN_ERROR.test(line)));
  if (log.length) blocks.push({ kind: "section", title: "Last log lines" }, { kind: "log", lines: log });

  const facts: MailFact[] = [...projectFact(event, ctx), ...(commitShown ? [] : commitFact(event)), ...triggerFact(event)];
  if (event.durationMs !== undefined) facts.push({ label: "Ran for", value: formatDuration(event.durationMs) });
  if (facts.length) blocks.push({ kind: "facts", facts });

  const links: MailLink[] = [];
  if (event.failedStage !== "build" && event.failedStage !== "clone") links.push({ label: "App logs", href: appPage(ctx, event.appId, "logs") });
  links.push({ label: "Redeploy", href: appPage(ctx, event.appId) });

  return {
    tone: "fail",
    status: "Failed",
    heading: stage ? `${name} failed at ${stage}` : `${name} failed to deploy`,
    preheader: [/[.!?]$/.test(cause.title) ? cause.title : `${cause.title}.`, event.serving ? SERVING_LINE[event.serving] : ""].filter(Boolean).join(" "),
    blocks,
    action: { label: "Open the deployment", href: appPage(ctx, event.appId, "deployments") },
    links,
    footer: footerFor(ctx),
  };
}
