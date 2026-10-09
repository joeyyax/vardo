import type { DigestWeeklyEvent } from "@/lib/bus/events";
import type { MailFact, MailTone, NotificationMailBody } from "./components";
import { consolePage, footerFor, type MailContext } from "./context";

export type DigestDeploySummary = { total: number; succeeded: number; failed: number };
export type DigestBackupSummary = { total: number; succeeded: number; failed: number };
export type DigestCronSummary = { totalFailures: number; affectedJobs: string[] };
export type DigestAlertSummary = { diskWriteAlerts: number; volumeDrifts: number };
export type DigestProjectRow = {
  name: string;
  deploys: number;
  failures: number;
  backupFailures: number;
  cronFailures: number;
};

function rate(ok: number, total: number): string {
  return total === 0 ? "none" : `${ok} of ${total} (${Math.round((ok / total) * 100)}%)`;
}

export function weeklyDigestMail(event: DigestWeeklyEvent, ctx: MailContext): NotificationMailBody {
  const backupsOk = event.backupsSucceeded ?? Math.max(0, event.backupsTotal - event.backupsFailed);
  const alerts = (event.diskWriteAlerts ?? 0) + (event.volumeDrifts ?? 0);
  const problems = event.deploysFailed + event.backupsFailed + event.cronFailed;
  const tone: MailTone = problems > 0 ? "warn" : "success";

  const facts: MailFact[] = [
    { label: "Deploys", value: rate(event.deploysSucceeded, event.deploysTotal) },
    { label: "Backups", value: rate(backupsOk, event.backupsTotal) },
    { label: "Cron failures", value: String(event.cronFailed) },
  ];
  if (event.cronAffectedJobs?.length) facts.push({ label: "Failing jobs", value: event.cronAffectedJobs.join(", ") });
  if (event.diskWriteAlerts !== undefined) facts.push({ label: "Disk write alerts", value: String(event.diskWriteAlerts) });
  if (event.volumeDrifts !== undefined) facts.push({ label: "Volume drift", value: String(event.volumeDrifts) });

  const projects = (event.projects ?? []).slice(0, 10).map((p) => {
    const issues = [
      p.failures && `${p.failures} failed`,
      p.backupFailures && `${p.backupFailures} backup`,
      p.cronFailures && `${p.cronFailures} cron`,
    ].filter(Boolean);
    return { label: p.name, value: `${p.deploys} deploys${issues.length ? ` · ${issues.join(", ")}` : ""}` };
  });

  return {
    tone,
    status: problems > 0 ? `${problems} to look at` : "All clear",
    heading: `${event.orgName}, week of ${event.weekLabel}`,
    preheader: `${event.deploysTotal} deploys, ${event.deploysFailed} failed, ${event.backupsFailed} backup failures${alerts ? `, ${alerts} alerts` : ""}`,
    facts,
    sections: projects.length ? [{ title: "By project", facts: projects }] : undefined,
    action: { label: "Open Vardo", href: consolePage(ctx, "/projects") },
    links: [{ label: "Activity", href: consolePage(ctx, "/activity") }],
    footer: footerFor(ctx),
  };
}
