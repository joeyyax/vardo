import type { BackupFailedEvent, BackupSuccessEvent } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { formatDuration, plural } from "../format";
import type { MailFact, NotificationMailBody } from "./components";
import { consolePage, footerFor, type MailContext } from "./context";
import { backupColumns } from "./visuals";

/** Charts for at most this many sources, largest first. */
const CHARTED_SOURCES = 3;

export function backupSuccessMail(event: BackupSuccessEvent, ctx: MailContext): NotificationMailBody {
  const facts: MailFact[] = [
    { label: "Size", value: formatBytesIec(event.totalSize) },
    { label: "Sources", value: String(event.totalCount) },
  ];
  if (event.skippedCount) facts.push({ label: "Skipped", value: String(event.skippedCount) });
  if (event.durationMs !== undefined) facts.push({ label: "Duration", value: formatDuration(event.durationMs) });

  const charted = [...(event.sources ?? [])]
    .map((s) => ({ s, chart: backupColumns(s.name, ctx.series?.backupHistory?.[s.name], s.sizeBytes) }))
    .filter((c) => c.chart !== undefined)
    .sort((a, b) => Number(Boolean(b.chart?.warning)) - Number(Boolean(a.chart?.warning)) || b.s.sizeBytes - a.s.sizeBytes)
    .slice(0, CHARTED_SOURCES)
    .map((c) => c.chart!);
  const warnings = charted.flatMap((c) => (c.warning ? [c.warning] : []));

  return {
    tone: warnings.length ? "warn" : "success",
    status: warnings.length ? "Backed up, check size" : "Backed up",
    heading: `Backup ${event.jobName} finished`,
    preheader: warnings[0]?.value ?? `${plural(event.totalCount, "source")}, ${formatBytesIec(event.totalSize)}`,
    paragraphs: warnings.length ? ["The backup finished, but it's much smaller than earlier runs. That can mean the data it copies went missing."] : undefined,
    visuals: charted.map((c) => c.visual),
    facts: [...warnings, ...facts],
    sections: event.sources?.length
      ? [{ title: "Sources", facts: event.sources.map((s) => ({ label: s.name, value: formatBytesIec(s.sizeBytes) })) }]
      : undefined,
    action: { label: "View backups", href: consolePage(ctx, "/backups") },
    footer: footerFor(ctx),
  };
}

export function backupFailedMail(event: BackupFailedEvent, ctx: MailContext): NotificationMailBody {
  const failures = event.failures?.length
    ? event.failures
    : event.errors
        .split("; ")
        .filter(Boolean)
        .map((entry) => {
          const at = entry.indexOf(": ");
          return at > 0 ? { name: entry.slice(0, at), error: entry.slice(at + 2) } : { name: "Source", error: entry };
        });

  const facts: MailFact[] = [{ label: "Failed", value: `${event.failedCount} of ${event.totalCount}` }];
  if (event.durationMs !== undefined) facts.push({ label: "Duration", value: formatDuration(event.durationMs) });

  return {
    tone: "fail",
    status: "Backup failed",
    heading: `Backup ${event.jobName} failed`,
    preheader: failures[0] ? `${failures[0].name}: ${failures[0].error}` : event.message,
    paragraphs: [event.message, "The last good backup is still there. Fix the cause, then run the job again."],
    facts,
    visuals: failures
      .slice(0, CHARTED_SOURCES)
      .map((f) => backupColumns(f.name, ctx.series?.backupHistory?.[f.name], null)?.visual)
      .filter((v) => v !== undefined),
    sections: failures.length ? [{ title: "What failed", facts: failures.map((f) => ({ label: f.name, value: f.error })) }] : undefined,
    action: { label: "View backups", href: consolePage(ctx, "/backups") },
    footer: footerFor(ctx),
  };
}
