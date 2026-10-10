import type { DigestHealthEvent } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { plural } from "../format";
import type { MailFact, MailTone, MailVisual, NotificationMailBody } from "./components";
import { consolePage, footerFor, type MailContext } from "./context";
import { sparkColumns } from "./visuals";
import { formatDayTime, UTC, zonedParts, zoneAbbreviation } from "@/lib/time-zone";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The daily chart's axis: midnight to midnight in the zone. */
function dayAxis(event: DigestHealthEvent, tz: string): [string, string] {
  return ["00:00", `24:00 ${zoneAbbreviation(new Date(event.since), tz)}`];
}

function rate(ok: number, total: number): string {
  return total === 0 ? "none" : `${ok} of ${total} (${Math.round((ok / total) * 100)}%)`;
}

function deployChart(event: DigestHealthEvent, tz: string): MailVisual | undefined {
  const buckets = event.deploysByBucket;
  if (!buckets?.length || buckets.every((b) => b.succeeded + b.failed === 0)) return undefined;
  const daily = event.cadence === "daily";
  return {
    kind: "columns",
    title: daily ? "Deploys per hour" : "Deploys per day",
    columns: buckets.map((b) => ({
      parts: [
        { value: b.succeeded, tone: 1 },
        { value: b.failed, tone: "fail" },
      ],
      label: daily ? undefined : WEEKDAYS[zonedParts(new Date(b.start), tz).weekday],
    })),
    axis: daily ? dayAxis(event, tz) : undefined,
    legend: [
      { label: "Succeeded", tone: 1 },
      { label: "Failed", tone: "fail" },
    ],
  };
}

function trendValue(t: NonNullable<DigestHealthEvent["resources"]>[number], v: number): string {
  return t.unit === "percent" ? `${Math.round(v)}%` : `${v.toFixed(2)} per core`;
}

export function healthDigestMail(event: DigestHealthEvent, ctx: MailContext): NotificationMailBody {
  const { deploys, backups, cron, alerts } = event;
  const problems = deploys.failed + backups.failed + backups.drillsFailed + cron.failed + alerts.open;
  const tone: MailTone = problems > 0 || backups.staleVolumes > 0 ? "warn" : "success";
  const period = event.cadence === "daily" ? "day" : "week";
  const tz = ctx.timeZone ?? UTC;
  const axis: [string, string] = event.cadence === "daily" ? dayAxis(event, tz) : ["start of week", "end"];

  const facts: MailFact[] = [
    { label: "Deploys", value: rate(deploys.succeeded, deploys.total) },
    {
      label: "Backups",
      value: [
        `${rate(backups.succeeded, backups.succeeded + backups.failed)}${backups.totalSize ? `, ${formatBytesIec(backups.totalSize)}` : ""}`,
        backups.runs ? plural(backups.runs, "run") : undefined,
        backups.lastRunAt ? `last ${formatDayTime(new Date(backups.lastRunAt), tz)}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    },
  ];
  const scans = event.scans;
  if (scans?.scanned) {
    const found = scans.appsWithFindings
      ? `${plural(scans.appsWithFindings, "app")} with findings${scans.critical ? ` (${scans.critical} critical)` : ""}`
      : "no open issues";
    const last = scans.lastRunAt ? ` · last ${formatDayTime(new Date(scans.lastRunAt), tz)}` : "";
    facts.push({ label: "Security scans", value: `${plural(scans.apps, "app")} scanned, ${found}${last}`});
  }
  if (backups.drillsPassed + backups.drillsFailed > 0) {
    facts.push({ label: "Restore drills", value: `${backups.drillsPassed} passed${backups.drillsFailed ? `, ${backups.drillsFailed} failed` : ""}` });
  }
  if (backups.staleVolumes) facts.push({ label: "Stale backups", value: `${plural(backups.staleVolumes, "volume")} with no success in 48 h` });
  facts.push({ label: "Alerts", value: `${alerts.fired} fired, ${alerts.resolved} resolved${alerts.open ? `, ${alerts.open} still open` : ""}` });
  if (cron.failed) facts.push({ label: "Cron failures", value: `${cron.failed}${cron.affectedJobs.length ? ` (${cron.affectedJobs.join(", ")})` : ""}` });

  const sections: { title: string; facts: MailFact[] }[] = [];
  if (alerts.top.length) sections.push({ title: "Alerts this " + period, facts: alerts.top.map((a) => ({ label: a.label, value: `${a.count}×` })) });
  if (event.resources?.length) {
    sections.push({
      title: "Host",
      facts: event.resources.map((t) => ({ label: t.label, value: `now ${trendValue(t, t.latest)}, peak ${trendValue(t, t.peak)}` })),
    });
  }
  if (event.certs.length) {
    sections.push({
      title: "Certificates expiring",
      facts: event.certs.slice(0, 10).map((c) => ({ label: c.domain, value: c.daysLeft <= 0 ? "Expired" : `${plural(c.daysLeft, "day")} left` })),
    });
  }
  if (event.imageUpdates.length) {
    sections.push({
      title: "Image updates available",
      facts: event.imageUpdates.slice(0, 10).map((u) => ({ label: u.appName, value: plural(u.count, "update") })),
    });
  }
  const projects = event.projects.slice(0, 10).map((p) => {
    const issues = [p.failures && `${p.failures} failed`, p.backupFailures && `${p.backupFailures} backup`, p.cronFailures && `${p.cronFailures} cron`].filter(Boolean);
    return { label: p.name, value: `${plural(p.deploys, "deploy")}${issues.length ? ` · ${issues.join(", ")}` : ""}` };
  });
  if (projects.length) sections.push({ title: "By project", facts: projects });

  const visuals = [
    deployChart(event, tz),
    ...(event.resources ?? []).slice(0, 3).map((t) => sparkColumns(`${t.label}, peak ${trendValue(t, t.peak)}`, t.values, { axis })),
  ].filter((v) => v !== undefined);

  return {
    tone,
    status: problems > 0 ? `${problems} to look at` : "All clear",
    heading: `${event.orgName}, ${event.cadence === "daily" ? "" : "week of "}${event.windowLabel}`,
    preheader: `${plural(deploys.total, "deploy")}, ${deploys.failed} failed, ${backups.failed} backup failures, ${plural(alerts.fired, "alert")}`,
    visuals,
    facts,
    sections,
    action: { label: "Open Vardo", href: consolePage(ctx, "/projects") },
    links: [
      { label: "Activity", href: consolePage(ctx, "/activity") },
      { label: "Backups", href: consolePage(ctx, "/backups") },
    ],
    footer: footerFor(ctx),
  };
}
