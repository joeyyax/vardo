import type { DeploySuccessEvent } from "@/lib/bus/events";
import { formatDuration } from "../format";
import { appLabel } from "../subjects";
import type { MailFact, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";
import { changeFacts, phaseVisual, placeFacts } from "./deploy-facts";

export function deploySuccessMail(event: DeploySuccessEvent, ctx: MailContext): NotificationMailBody {
  const name = appLabel(event);
  const primary = event.domains?.[0] ?? event.domain;

  const run: MailFact[] = [];
  const duration = event.durationMs !== undefined ? formatDuration(event.durationMs) : event.duration;
  if (duration) run.push({ label: "Duration", value: duration });
  if (event.slot) {
    run.push({ label: "Slot", value: event.previousSlot ? `${event.previousSlot} → ${event.slot}` : event.slot });
  }

  return {
    tone: "success",
    status: "Deployed",
    heading: `${name} is live`,
    preheader: [event.gitMessage, duration && `in ${duration}`].filter(Boolean).join(" · ") || `${name} deployed`,
    visuals: [phaseVisual(event.stageTimings, undefined, { caption: !duration })].filter((v) => v !== undefined),
    facts: [...placeFacts(event), ...changeFacts(event), ...run],
    action: primary ? { label: `Open ${primary}`, href: `https://${primary}` } : { label: "Open app", href: appPage(ctx, event.appId) },
    links: [
      { label: "Deployment log", href: appPage(ctx, event.appId, "deployments") },
      ...(primary ? [{ label: "App", href: appPage(ctx, event.appId) }] : []),
      { label: "Roll back", href: appPage(ctx, event.appId, "deployments") },
    ],
    footer: footerFor(ctx),
  };
}
