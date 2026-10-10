import type { DeployRollbackEvent } from "@/lib/bus/events";
import { appLabel } from "../subjects";
import type { MailFact, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";

export function autoRollbackMail(event: DeployRollbackEvent, ctx: MailContext): NotificationMailBody {
  const name = appLabel(event);
  const facts: MailFact[] = [];
  if (event.restoredSlot) facts.push({ label: "Serving from", value: event.restoredSlot });
  facts.push({ label: "What happened", value: event.message });

  return event.rollbackSuccess
    ? {
        tone: "warn",
        status: "Rolled back",
        heading: `${name} rolled back to the previous release`,
        preheader: event.message,
        paragraphs: [
          "The new release stopped within its grace period, so Vardo switched traffic back. The previous release is serving.",
        ],
        facts,
        log: event.logTail?.length ? { title: "Last log lines", lines: event.logTail } : undefined,
        action: { label: "Open deployment log", href: appPage(ctx, event.appId, "deployments") },
        links: [{ label: "App logs", href: appPage(ctx, event.appId, "logs") }],
        footer: footerFor(ctx),
      }
    : {
        tone: "fail",
        status: "Rollback failed",
        heading: `${name} crashed and the rollback failed`,
        preheader: event.message,
        paragraphs: ["The new release stopped and the previous one couldn't be restored. Nothing may be serving this app."],
        facts,
        log: event.logTail?.length ? { title: "Last log lines", lines: event.logTail } : undefined,
        action: { label: "Open app", href: appPage(ctx, event.appId) },
        links: [
          { label: "Deployment log", href: appPage(ctx, event.appId, "deployments") },
          { label: "App logs", href: appPage(ctx, event.appId, "logs") },
        ],
        footer: footerFor(ctx),
      };
}
