import type { CronFailedEvent } from "@/lib/bus/events";
import { formatDuration } from "../format";
import type { MailFact, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";

export function cronFailedMail(event: CronFailedEvent, ctx: MailContext): NotificationMailBody {
  const facts: MailFact[] = [{ label: "App", value: event.projectName || "Unnamed app", href: appPage(ctx, event.appId) }];
  if (event.schedule) facts.push({ label: "Schedule", value: event.schedule, mono: true });
  if (event.command) facts.push({ label: "Command", value: event.command, mono: true });
  facts.push({ label: "Ran for", value: formatDuration(event.durationMs) });

  const lines = event.logTail?.length ? event.logTail : event.message.split("\n");

  return {
    tone: "fail",
    status: "Cron failed",
    heading: `Cron job ${event.cronJobName} failed`,
    preheader: lines.filter(Boolean).at(-1) ?? event.message,
    facts,
    log: { title: "Output", lines },
    action: { label: "Open cron jobs", href: appPage(ctx, event.appId, "cron") },
    links: [{ label: "App logs", href: appPage(ctx, event.appId, "logs") }],
    footer: footerFor(ctx),
  };
}
