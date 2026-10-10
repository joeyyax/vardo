import type { CronFailedEvent } from "@/lib/bus/events";
import { describeSchedule } from "@/lib/cron/describe";
import { formatDuration } from "../format";
import type { MailFact, NotificationMailBody } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function cronFailedMail(event: CronFailedEvent, ctx: MailContext): NotificationMailBody {
  const appId = event.appId;
  const app = event.projectName || "its app";
  const url = event.jobType === "url";
  const schedule = event.schedule ? describeSchedule(event.schedule) : undefined;

  const facts: MailFact[] = appId ? [{ label: "App", value: app, href: appPage(ctx, appId) }] : [];
  if (event.exitCode !== undefined) facts.push({ label: url ? "HTTP status" : "Exit code", value: String(event.exitCode) });
  if (event.command && !url) facts.push({ label: "Command", value: event.command, mono: true });
  if (event.target) facts.push({ label: url ? "URL" : "Container", value: event.target, mono: true });
  if (schedule) facts.push({ label: "Schedule", value: schedule === event.schedule ? schedule : `${schedule} (${event.schedule})` });
  facts.push({ label: "Ran for", value: formatDuration(event.durationMs) });
  facts.push({ label: "Last success", value: event.lastSuccessAt ? when(event.lastSuccessAt) : "None on record" });

  const lines = event.logTail?.length ? event.logTail : event.message.split("\n");

  return {
    tone: "fail",
    status: "Cron failed",
    heading: appId ? `Cron job ${event.cronJobName} failed on ${app}` : `Cron job ${event.cronJobName} failed`,
    preheader: lines.filter(Boolean).at(-1) ?? event.message,
    facts,
    log: { title: "Output", lines },
    action: { label: "Open run history", href: appId ? appPage(ctx, appId, "cron") : consolePage(ctx, "/cron") },
    links: appId
      ? [
          { label: "App", href: appPage(ctx, appId) },
          { label: "App logs", href: appPage(ctx, appId, "logs") },
        ]
      : [],
    footer: footerFor(ctx),
  };
}
