import type { AppRecap, DigestHealthEvent, DigestWatchedProject } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { UTC } from "@/lib/time-zone";
import { stoppedBackupLabel } from "@/lib/backups/staleness";
import { plural } from "../format";
import { buildTime, nearLimit, recapIssues, size } from "./app-recap";
import { linkedList, nameLink, type MailBlock, type MailFact, type MailInline, type MailRich, type NotificationMailBody, type StatTile, type StatsRow, type VolumeRow } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";

type Callout = Extract<MailBlock, { kind: "callout" }>;

const LIST_MAX = 10;

function day(iso: string | Date, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

function share(ok: number, total: number): number {
  return total ? Math.round((ok / total) * 100) : 0;
}

function projectHref(ctx: MailContext, id: string): string {
  return consolePage(ctx, `/projects/${id}`);
}

const appLink = (ctx: MailContext, name: string, appId?: string | null) => nameLink(name, appId ? appPage(ctx, appId) : undefined);

/** "October", "Week of Oct 5", from the label the collector cut in the org's zone. */
export function digestHeading(event: Pick<DigestHealthEvent, "cadence" | "windowLabel">): string {
  return event.cadence === "monthly" ? event.windowLabel.split(" ")[0]! : `Week of ${event.windowLabel.split(/ –|,/)[0]}`;
}

/** What needs a person, most pressing first. Never suggests lowering a limit. */
export function digestCallouts(event: DigestHealthEvent, ctx: MailContext): Callout[] {
  const out: Callout[] = [];
  const { backups, cron } = event;
  if (backups.staleVolumes) {
    const apps = (event.staleApps ?? []).slice(0, 3);
    out.push({
      kind: "callout",
      tone: "warn",
      title: `${plural(backups.staleVolumes, "volume")} without a backup in 48 hours`,
      body: apps.length ? [apps.length > 1 ? "Mostly in " : "In ", ...linkedList(apps.map((a) => ({ text: a.appName, href: a.appId ? appPage(ctx, a.appId, "backups") : undefined }))), "."] : undefined,
      action: { label: "Open backups", href: consolePage(ctx, "/backups") },
    });
  }
  if (backups.drillsFailed) {
    const failed = (event.drillFailures ?? []).slice(0, 3);
    const body: MailInline[] = [];
    failed.forEach((f, i) => {
      if (i > 0) body.push(i === failed.length - 1 ? " and " : ", ");
      body.push(appLink(ctx, f.appName, f.appId), ` / ${f.volume}`);
    });
    out.push({
      kind: "callout",
      tone: "warn",
      title: `${plural(backups.drillsFailed, "restore drill")} failed`,
      body: body.length ? [...body, "."] : undefined,
      action: { label: "View drills", href: consolePage(ctx, "/backups") },
    });
  }
  for (const o of (event.oomApps ?? []).slice(0, 3)) {
    out.push({
      kind: "callout",
      tone: "warn",
      title: [appLink(ctx, o.appName, o.appId), ` was killed for memory ${times(o.count)}`],
      action: { label: "Adjust the limit", href: appPage(ctx, o.appId, "resources") },
    });
  }
  if (cron.failed) {
    out.push({
      kind: "callout",
      tone: "warn",
      title: `${plural(cron.failed, "cron run")} failed`,
      body: cron.affectedJobs.length ? `${cron.affectedJobs.join(", ")}.` : undefined,
      action: { label: "Open cron jobs", href: consolePage(ctx, "/cron") },
    });
  }
  return out;
}

/** "391 deploys across 44 apps. Backups ran 98% of the time and all 9 alerts resolved." */
function lead(event: DigestHealthEvent): string {
  const { deploys, backups, alerts } = event;
  const across = event.appCount ? ` across ${plural(event.appCount, "app")}` : "";
  const first = `${plural(deploys.total, "deploy")}${across}.`;
  const ran = backups.succeeded + backups.failed;
  const backupPart = ran ? `Backups ran ${share(backups.succeeded, ran)}% of the time` : "";
  const alertPart = alerts.open
    ? `${plural(alerts.open, "alert")} still open`
    : alerts.fired
      ? `${alerts.fired === 1 ? "the one alert" : `all ${alerts.fired} alerts`} resolved`
      : "no alerts fired";
  const second = backupPart ? `${backupPart} and ${alertPart}.` : `${alertPart.charAt(0).toUpperCase()}${alertPart.slice(1)}.`;
  return `${first} ${second}`;
}

function orgTiles(event: DigestHealthEvent): StatTile[] {
  const { deploys, backups, alerts, scans } = event;
  const ranBackups = backups.succeeded + backups.failed;
  const drills = backups.drillsPassed + backups.drillsFailed;
  const updates = event.imageUpdates.reduce((n, u) => n + u.count, 0);
  const none = event.cadence === "monthly" ? "none this month" : "none this week";
  return [
    deploys.total
      ? { label: "Deploys", value: String(deploys.succeeded), unit: `/${deploys.total}`, sub: `${share(deploys.succeeded, deploys.total)}% succeeded` }
      : { label: "Deploys", value: "0", sub: none },
    ranBackups
      ? { label: "Backups", value: backups.succeeded.toLocaleString("en-US"), unit: `/${ranBackups.toLocaleString("en-US")}`, sub: backups.totalSize ? `${formatBytesIec(backups.totalSize)} backed up` : undefined }
      : { label: "Backups", value: "0", sub: none },
    drills
      ? { label: "Restore drills", value: String(backups.drillsPassed), unit: `/${drills}`, sub: backups.drillsFailed ? `${backups.drillsFailed} failed` : "all passed" }
      : { label: "Restore drills", value: "—", sub: "none ran" },
    { label: "Alerts", value: String(alerts.fired), sub: alerts.open ? `${alerts.open} still open` : alerts.fired ? "all resolved" : "none fired", hot: alerts.open > 0 },
    scans?.scanned
      ? { label: "Security scans", value: String(scans.apps), sub: scans.appsWithFindings ? `apps · ${scans.appsWithFindings} with findings` : "apps · no open issues", hot: scans.critical > 0 }
      : { label: "Security scans", value: "—", sub: "none ran" },
    { label: "Image updates", value: String(updates), sub: updates ? `across ${plural(event.imageUpdates.length, "app")}` : "all current" },
  ];
}

function deployColumns(days: { succeeded: number; failed: number }[]): MailBlock[] {
  if (!days.some((d) => d.succeeded + d.failed > 0)) return [];
  return [
    { kind: "section", title: "Deploys per day" },
    {
      kind: "columns",
      columns: days.map((d) => ({ parts: [{ value: d.succeeded + d.failed, tone: d.failed ? "fail" : 1 }] })),
      legend: [
        { label: "succeeded", tone: 1 },
        { label: "had a failure", tone: "fail" },
      ],
    },
  ];
}

function hostBlocks(event: DigestHealthEvent): MailBlock[] {
  const trends = event.resources ?? [];
  if (!trends.length) return [];
  const value = (t: (typeof trends)[number], v: number) => (t.unit === "percent" ? pct(v) : v.toFixed(2));
  const days = event.deploysByBucket?.length ?? 0;
  const covered = Math.max(...trends.map((t) => t.values.length));
  return [
    { kind: "section", title: "Host" },
    {
      kind: "stats",
      columns: ["Resource", { label: "Daily peak", align: "left", width: "44%" }, "Now", "Peak"],
      rows: trends.map((t) => ({
        name: t.label,
        sub: t.unit === "per-core" ? "per core" : undefined,
        cells: [{ value: "", spark: t.values }, value(t, t.latest), value(t, t.peak)],
      })),
      footer: days && covered < days ? `Host history covers the last ${plural(covered, "day")}.` : undefined,
    },
  ];
}

function factsSection(title: string, facts: MailFact[]): MailBlock[] {
  return facts.length ? [{ kind: "section", title }, { kind: "facts", facts }] : [];
}

/** "44 days" or "3 hours" for how long an app was stopped. */
export function stoppedFor(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours < 48 ? plural(Math.max(1, hours), "hour") : plural(Math.round(ms / 86_400_000), "day");
}

function changeFacts(event: DigestHealthEvent, ctx: MailContext, tz: string): MailFact[] {
  const groups = new Map<string, { appId: string; appName: string; kind: "port" | "process"; items: string[]; since: string }>();
  for (const c of event.changes ?? []) {
    const key = `${c.appId}:${c.kind}`;
    const g = groups.get(key) ?? { appId: c.appId, appName: c.appName, kind: c.kind, items: [], since: c.since };
    g.items.push(c.item);
    groups.set(key, g);
  }
  return [...groups.values()].slice(0, LIST_MAX).map((g) => {
    const verb = g.kind === "port" ? "Now listening on" : "Now runs";
    const when = ` since ${day(g.since, tz)}`;
    return {
      label: g.appName,
      labelHref: appPage(ctx, g.appId),
      value: `${verb} ${g.items.join(", ")}${when}`,
      rich: [`${verb} `, ...g.items.map((item) => ({ chip: item, new: true })), when],
    };
  });
}

function updateFacts(event: DigestHealthEvent, ctx: MailContext): MailFact[] {
  const shown = event.imageUpdates.slice(0, 3);
  const rest = event.imageUpdates.slice(3);
  const facts: MailFact[] = shown.map((u) => ({ label: u.appName, labelHref: u.appId ? appPage(ctx, u.appId) : undefined, value: plural(u.count, "update") }));
  if (rest.length) {
    const each = rest.every((u) => u.count === 1) ? ", 1 each" : `, ${plural(rest.reduce((n, u) => n + u.count, 0), "update")}`;
    const names = rest.map((u) => ({ text: u.appName, href: u.appId ? appPage(ctx, u.appId) : undefined }));
    facts.push({ label: `${rest.length} more apps`, value: `${rest.map((u) => u.appName).join(", ")}${each}`, rich: [...linkedList(names), each] });
  }
  for (const n of (event.majorNotices ?? []).slice(0, LIST_MAX)) facts.push({ label: n.appName, value: n.detail });
  return facts;
}

function projectRows(event: DigestHealthEvent, ctx: MailContext): MailBlock[] {
  const shown = event.projects.slice(0, LIST_MAX);
  const more = (event.quietProjects ?? 0) + event.projects.length - shown.length;
  if (!shown.length) return [];
  const rows: StatsRow[] = shown.map((p) => ({
    name: p.name,
    href: p.id ? projectHref(ctx, p.id) : p.appId ? appPage(ctx, p.appId) : undefined,
    sub: p.apps?.join(", "),
    why: p.cronFailures ? plural(p.cronFailures, "failed cron run") : undefined,
    cells: [
      { value: String(p.deploys), sub: p.failures ? `${p.failures} failed` : undefined, hot: p.failures > 0 },
      p.backups ? { value: `${p.backups.succeeded}/${p.backups.total}`, hot: p.backupFailures > 0 } : "—",
      p.cpu != null ? pct(p.cpu) : "—",
      p.memory != null ? size(p.memory) : "—",
    ],
  }));
  const footer: MailRich | undefined = more
    ? [`and ${plural(more, "more project")} with no deploys or issues · `, nameLink("View all", consolePage(ctx, "/projects"))]
    : undefined;
  return [{ kind: "section", title: "Projects" }, { kind: "stats", columns: ["Project", "Deploys", "Backups", "CPU", "Memory"], rows, footer }];
}

// Watched projects.

function sum(apps: AppRecap[], pick: (r: AppRecap) => number | undefined | null): number {
  return apps.reduce((n, r) => n + (pick(r) ?? 0), 0);
}

function uptimeValue(ratio: number): string {
  return ratio >= 1 ? "100" : (Math.floor(ratio * 10_000) / 100).toFixed(2);
}

function watchedLead(w: DigestWatchedProject): string {
  const n = w.apps.length;
  const deploys = sum(w.apps, (r) => r.deploys.total);
  const failed = sum(w.apps, (r) => r.deploys.failed);
  const up = !w.uptime
    ? ""
    : w.uptime.downMinutes === 0
      ? n === 1
        ? `${w.apps[0]!.appName} stayed up. `
        : `All ${n} sites stayed up. `
      : `${w.uptime.downMinutes} min down${n > 1 ? ` across ${n} sites` : ""}. `;
  return `${up}${plural(deploys, "deploy")}${failed ? `, ${failed} failed` : ""}.`;
}

function watchedTiles(w: DigestWatchedProject, tz: string): StatTile[] {
  const builds = w.apps.flatMap((r) => (r.build ? [r.build] : []));
  const rx = sum(w.apps, (r) => r.network?.rx);
  const tx = sum(w.apps, (r) => r.network?.tx);
  const nights = w.apps.flatMap((r) => r.backups?.nights ?? []);
  const ran = nights.filter((n) => n === "ok").length;
  const tried = nights.filter((n) => n !== "none").length;
  const lastBackup = w.apps.map((r) => r.backups?.lastAt).filter((d): d is string => !!d).sort().at(-1);
  const deploys = sum(w.apps, (r) => r.deploys.total);
  const failed = sum(w.apps, (r) => r.deploys.failed);
  const [bigValue, bigUnit] = size(Math.max(rx, tx)).split(" ");
  return [
    w.uptime
      ? { label: "Uptime", value: uptimeValue(w.uptime.ratio), unit: "%", sub: w.uptime.downMinutes ? `${w.uptime.downMinutes} min down` : "no downtime" }
      : { label: "Uptime", value: "—", sub: "no public domain" },
    w.response
      ? { label: "Response time", value: String(Math.round(w.response.p50)), unit: " ms", sub: `median · p95 ${Math.round(w.response.p95)} ms` }
      : { label: "Response time", value: "—", sub: "no checks" },
    rx + tx > 0
      ? { label: "Bandwidth", value: bigValue!, unit: ` ${bigUnit}`, sub: tx >= rx ? `out · ${size(rx)} in` : `in · ${size(tx)} out` }
      : { label: "Bandwidth", value: "—", sub: "no samples" },
    { label: "Deploys", value: String(deploys), sub: failed ? `${failed} failed` : deploys ? "all succeeded" : "none" },
    builds.length
      ? {
          label: "Average build",
          value: buildTime(builds.reduce((n, b) => n + b.avgMs, 0) / builds.length),
          sub: `fastest ${buildTime(Math.min(...builds.map((b) => b.fastestMs)))}`,
        }
      : { label: "Average build", value: "—", sub: "prebuilt images" },
    tried
      ? { label: "Backups", value: String(ran), unit: `/${tried}`, sub: lastBackup ? `last ran ${day(lastBackup, tz)}` : undefined }
      : { label: "Backups", value: "—", sub: "none set up" },
  ];
}

/** A site's issues, without image updates: the digest lists those in their own section. */
function siteIssues(r: AppRecap, ctx: MailContext) {
  return recapIssues({ ...r, imageUpdates: 0 }, ctx);
}

function siteRow(r: AppRecap, w: DigestWatchedProject, ctx: MailContext): StatsRow {
  const issue = siteIssues(r, ctx)[0];
  const hot = nearLimit(r.memory) || r.oomKills > 0;
  return {
    name: r.appName,
    href: appPage(ctx, r.appId),
    sub: w.domains[r.appId],
    why: issue ? [`${issue.short} · `, nameLink(issue.shortAction, issue.action.href)] : undefined,
    cells: [
      r.uptime ? `${uptimeValue(r.uptime.ratio)}%` : "—",
      { value: String(r.deploys.total), sub: r.deploys.failed ? `${r.deploys.failed} failed` : undefined },
      r.memory ? { value: size(r.memory.avg), hot, sub: hot ? "near limit" : undefined } : "—",
      r.network ? size(r.network.rx + r.network.tx) : "—",
    ],
  };
}

/** Per day: failed if any site's backup failed, ran if any ran. */
function combinedNights(apps: AppRecap[]): ("ok" | "fail" | "none")[] {
  const lists = apps.flatMap((r) => (r.backups?.nights ? [r.backups.nights] : []));
  if (!lists.length) return [];
  const len = Math.max(...lists.map((l) => l.length));
  return Array.from({ length: len }, (_, i) => {
    const states = lists.map((l) => l[i] ?? "none");
    return states.includes("fail") ? "fail" : states.includes("ok") ? "ok" : "none";
  });
}

function watchedBlocks(w: DigestWatchedProject, ctx: MailContext, tz: string): MailBlock[] {
  const blocks: MailBlock[] = [
    { kind: "section", title: ["Watching ", nameLink(w.name, projectHref(ctx, w.projectId))] },
    { kind: "text", text: watchedLead(w) },
    { kind: "tiles", tiles: watchedTiles(w, tz) },
  ];
  const needs = w.apps.filter((r) => siteIssues(r, ctx).length > 0);
  const ordered = [...needs, ...w.apps.filter((r) => !needs.includes(r))];
  blocks.push({ kind: "stats", columns: ["Site", "Uptime", "Deploys", "Memory", "Bandwidth"], rows: ordered.map((r) => siteRow(r, w, ctx)) });

  const byDay = w.apps.reduce<{ succeeded: number; failed: number }[]>((acc, r) => {
    (r.deploysByDay ?? []).forEach((d, i) => {
      acc[i] ??= { succeeded: 0, failed: 0 };
      acc[i].succeeded += d.succeeded;
      acc[i].failed += d.failed;
    });
    return acc;
  }, []);
  blocks.push(...deployColumns(byDay));
  if (w.hours.some((v) => v > 0)) blocks.push({ kind: "section", title: "Busiest hours" }, { kind: "hours", values: w.hours });

  const findings = sum(w.apps, (r) => r.scanFindings);
  const pub: MailFact[] = [{ label: "Security scan", value: findings ? `${plural(findings, "open finding")}` : "No open findings" }];
  if (w.certs.count) {
    pub.push({ label: "Certificates", value: `${plural(w.certs.count, "certificate")}${w.certs.nextExpiresAt ? ` · next expires ${day(w.certs.nextExpiresAt, tz)}` : ""}` });
  }
  blocks.push(...factsSection("Public sites", pub));

  const vols: VolumeRow[] = w.apps
    .flatMap((r) => r.volumes)
    .filter((v) => v.sizeBytes !== null || v.unprotected)
    .map((v) => ({ name: v.name, size: v.sizeBytes !== null ? size(v.sizeBytes) : "—", value: v.sizeBytes ?? 0, flag: v.unprotected ? "no backups" : undefined }));
  if (vols.length) blocks.push({ kind: "section", title: "Storage" }, { kind: "volumes", rows: vols, caption: vols.length > 1 ? "Bars compare this project's volumes." : undefined });

  const nights = combinedNights(w.apps);
  if (nights.some((n) => n !== "none")) {
    const ran = nights.filter((n) => n === "ok").length;
    blocks.push({ kind: "section", title: "Nightly backups" }, { kind: "days", days: nights, legend: ["ran", "failed"], summary: `${ran} of ${nights.length} ran` });
  }
  blocks.push(
    ...factsSection(
      "Image updates",
      w.apps.filter((r) => r.imageUpdates).map((r) => ({ label: r.appName, labelHref: appPage(ctx, r.appId), value: plural(r.imageUpdates!, "update") })),
    ),
  );
  return blocks;
}

export function digestMail(event: DigestHealthEvent, ctx: MailContext): NotificationMailBody {
  const tz = ctx.timeZone ?? UTC;
  const callouts = digestCallouts(event, ctx);
  const blocks: MailBlock[] = [{ kind: "text", text: lead(event) }, ...callouts, { kind: "tiles", tiles: orgTiles(event) }];
  blocks.push(...deployColumns(event.deploysByBucket ?? []));
  blocks.push(...hostBlocks(event));
  blocks.push(...factsSection("Alerts", event.alerts.top.map((a) => ({ label: a.label, value: String(a.count) }))));
  blocks.push(
    ...factsSection(
      "New apps",
      (event.newApps ?? []).slice(0, LIST_MAX).map((a) => ({
        label: a.appName,
        labelHref: appPage(ctx, a.appId),
        value: `Deployed ${day(a.deployedAt, tz)}${a.monthRecapAt ? ` · 30-day recap on ${day(a.monthRecapAt, tz)}` : ""}`,
      })),
    ),
  );
  blocks.push(
    ...factsSection(
      "Started and stopped",
      (event.lifecycle ?? []).slice(-LIST_MAX).map((c) => ({
        label: c.appName,
        labelHref: appPage(ctx, c.appId),
        value: c.kind === "stopped" ? `Stopped ${day(c.at, tz)}` : `Started ${day(c.at, tz)}${c.stoppedMs !== null ? ` after ${stoppedFor(c.stoppedMs)} stopped` : ""}`,
      })),
    ),
  );
  blocks.push(
    ...factsSection(
      "Backups on hold",
      (event.stoppedBackups ?? []).slice(0, LIST_MAX).map((s) => ({
        label: s.appName,
        labelHref: appPage(ctx, s.appId, "backups"),
        value: stoppedBackupLabel(s.lastBackupAt ? new Date(s.lastBackupAt) : null, tz),
      })),
    ),
  );
  blocks.push(...factsSection("From deploys", changeFacts(event, ctx, tz)));
  blocks.push(...factsSection("Image updates", updateFacts(event, ctx)));
  blocks.push(
    ...factsSection(
      "Certificates expiring",
      event.certs.slice(0, LIST_MAX).map((c) => ({ label: c.domain, value: c.daysLeft <= 0 ? "Expired" : `${plural(c.daysLeft, "day")} left` })),
    ),
  );
  blocks.push(...projectRows(event, ctx));
  for (const w of event.watched ?? []) blocks.push(...watchedBlocks(w, ctx, tz));

  const watching = (event.watched ?? []).map((w) => w.name);
  const sent = `Sent ${event.cadence}.`;
  const heading = digestHeading(event);
  return {
    tone: callouts.length ? "warn" : "info",
    status: "Digest",
    heading,
    preheader: lead(event),
    blocks,
    action: { label: "Open Vardo", href: consolePage(ctx, "/projects") },
    links: watching.length ? [{ label: "Stop watching", href: footerFor(ctx).settingsUrl }] : undefined,
    footer: {
      ...footerFor(ctx),
      note: watching.length ? `${sent} You're watching ${watching.join(", ")}.` : sent,
      settingsLabel: event.cadence === "monthly" ? "Switch to weekly or turn off" : "Switch to monthly or turn off",
    },
  };
}

/** "October in Acme · 3 need you". */
export function digestSubject(event: DigestHealthEvent): string {
  const needs = digestCallouts(event, { baseUrl: "", instanceName: "" }).length;
  return `${digestHeading(event)} in ${event.orgName}${needs ? ` · ${needs} need you` : ""}`;
}
