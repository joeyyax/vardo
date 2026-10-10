import type { CronFailedEvent } from "@/lib/bus/events";
import { describeSchedule } from "@/lib/cron/describe";
import { formatDuration } from "../format";
import type { MailFact, NotificationMailBody } from "./components";
import { appPage, footerFor, type MailContext } from "./context";

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function cronFailedMail(event: CronFailedEvent, ctx: MailContext): NotificationMailBody {
  const app = event.projectName || "its app";
  const url = event.jobType === "url";
  const schedule = event.schedule ? describeSchedule(event.schedule) : undefined;

  const facts: MailFact[] = [{ label: "App", value: app, href: appPage(ctx, event.appId) }];
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
    heading: `Cron job ${event.cronJobName} failed on ${app}`,
    preheader: lines.filter(Boolean).at(-1) ?? event.message,
    facts,
    log: { title: "Output", lines },
    action: { label: "Open run history", href: appPage(ctx, event.appId, "cron") },
    links: [
      { label: "App", href: appPage(ctx, event.appId) },
      { label: "App logs", href: appPage(ctx, event.appId, "logs") },
    ],
    footer: footerFor(ctx),
  };
}
