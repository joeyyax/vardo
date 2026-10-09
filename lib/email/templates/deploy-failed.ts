import type { DeployFailedEvent } from "@/lib/bus/events";
import { formatDuration, formatPhases } from "../format";
import { appLabel, stageLabel } from "../subjects";
import type { MailFact, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";
import { changeFacts, placeFacts } from "./deploy-facts";

const SERVING: Record<NonNullable<DeployFailedEvent["serving"]>, string> = {
  previous: "The previous release is still serving.",
  new: "The new release passed its health check and is serving.",
  none: "Nothing is serving this app right now.",
};

export function deployFailedMail(event: DeployFailedEvent, ctx: MailContext): NotificationMailBody {
  const name = appLabel(event);
  const stage = stageLabel(event.failedStage);
  const reason = (event.errorMessage || event.message).replace(/\. See logs above\.?$/, ".");

  const facts: MailFact[] = [];
  if (stage) facts.push({ label: "Failed at", value: stage });
  if (reason) facts.push({ label: "Reason", value: reason });
  if (event.crashReason) facts.push({ label: "Crash", value: event.crashReason, mono: true });
  facts.push(...placeFacts(event), ...changeFacts(event));
  if (event.durationMs !== undefined) facts.push({ label: "Ran for", value: formatDuration(event.durationMs) });
  const phases = formatPhases(event.stageTimings);
  if (phases) facts.push({ label: "Phases", value: phases });

  const paragraphs = [event.serving ? SERVING[event.serving] : "", "Fix the cause, then redeploy or roll back."].filter(Boolean);

  return {
    tone: "fail",
    status: "Failed",
    heading: stage ? `${name} failed at ${stage}` : `${name} failed to deploy`,
    preheader: event.crashReason || reason || paragraphs[0],
    paragraphs,
    facts,
    log: event.logTail?.length ? { title: "Last log lines", lines: event.logTail } : undefined,
    action: { label: "Open deployment log", href: appPage(ctx, event.appId, "deployments") },
    links: [
      { label: "Redeploy", href: appPage(ctx, event.appId) },
      { label: "Roll back", href: appPage(ctx, event.appId, "deployments") },
      { label: "App logs", href: appPage(ctx, event.appId, "logs") },
    ],
    footer: footerFor(ctx),
  };
}
