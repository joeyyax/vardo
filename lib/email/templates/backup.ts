import { backupErrorCause, dayAt, firstErrorLine } from "@/lib/backups/failure-alert";
import { summarizeApps } from "@/lib/backups/run-rules";
import type { BackupSummaryEvent, BackupSummaryRow } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { formatClock, UTC, zoneAbbreviation } from "@/lib/time-zone";
import { backupJobLabel, backupRunTotal, formatDuration, plural } from "../format";
import { linkedList, nameLink, type MailBlock, type MailInline, type MailLink, type MailTone, type NotificationMailBody, type StatTile } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";

type Stale = NonNullable<BackupSummaryEvent["staleVolumes"]>[number];

const FAILED_TITLE: Record<Exclude<BackupSummaryRow["kind"], "backup">, [string, string]> = {
  restore: ["Restore of ", " failed"],
  import: ["Import into ", " failed"],
  drill: ["Restore drill of ", " failed"],
};

const KIND_TITLES: Record<Exclude<BackupSummaryRow["kind"], "backup">, string> = {
  restore: "Restores",
  import: "Imports",
  drill: "Restore drills",
};

/** The rows the email sorts into. */
function sortRows(event: BackupSummaryEvent) {
  const rows = event.rows;
  return {
    failed: rows.filter((r) => r.outcome === "failed"),
    shrunk: rows.filter((r) => r.shrunk),
    skipped: rows.filter((r) => r.outcome === "skipped" && !r.expected),
    routine: rows.filter((r) => r.outcome === "skipped" && r.expected && !r.config),
    config: rows.filter((r) => r.config),
    unfinished: event.run.unfinished ?? [],
    stale: event.staleVolumes ?? [],
  };
}

/** Callouts the email shows: one per failed or shrunk row, one each for skips, unfinished jobs and stale volumes. */
export function backupProblemCount(event: BackupSummaryEvent): number {
  const s = sortRows(event);
  return s.failed.length + s.shrunk.length + [s.skipped, s.unfinished, s.stale].filter((l) => l.length).length;
}

function link(text: string, appId: string | null | undefined, ctx: MailContext, tab?: string): MailInline {
  return nameLink(text, appId ? appPage(ctx, appId, tab) : undefined);
}

/** "Shop / mysql-data" with the app linked, or the volume alone when it's named for the app. */
function rowName(row: { appId?: string | null; appName: string; volumeName: string }, ctx: MailContext): MailInline[] {
  return row.appName === row.volumeName ? [row.volumeName] : [link(row.appName, row.appId, ctx), ` / ${row.volumeName}`];
}

function rowText(row: { appName: string; volumeName: string }): string {
  return row.appName === row.volumeName ? row.volumeName : `${row.appName} / ${row.volumeName}`;
}

function clock(iso: string, tz: string): string {
  const date = new Date(iso);
  return `${formatClock(date, tz)} ${zoneAbbreviation(date, tz)}`;
}

/** "41 min" as a tile's value and unit. */
function tileParts(text: string): { value: string; unit?: string } {
  const m = /^([\d.,]+) ([A-Za-z]+)$/.exec(text);
  return m ? { value: m[1], unit: ` ${m[2]}` } : { value: text };
}

/** "+1%", "-12%" or "same". */
function pct(fraction: number): string {
  const n = Math.round(fraction * 100);
  return n === 0 ? "same" : `${n > 0 ? "+" : ""}${n.toLocaleString("en-US")}%`;
}

/** Size change of this run's backups against their last run, as a fraction. Undefined without history. */
function sizeChange(rows: BackupSummaryRow[]): number | undefined {
  let now = 0;
  let before = 0;
  for (const r of rows) {
    if (r.kind !== "backup" || r.outcome !== "success" || r.previousSize === undefined) continue;
    now += r.sizeBytes;
    before += r.previousSize;
  }
  return before > 0 ? (now - before) / before : undefined;
}

function failedCallout(row: BackupSummaryRow, ctx: MailContext): MailBlock {
  const tz = ctx.timeZone ?? UTC;
  const cause = backupErrorCause(row.error);
  const line = firstErrorLine(row.error);
  const body: MailInline[] = cause ? [cause] : line ? [{ text: line, mono: true }, "."] : ["It failed without an error message."];
  if (row.kind === "backup" && row.lastGoodAt) body.push(` Its last good backup, from ${dayAt(row.lastGoodAt, tz)}, is still there.`);
  body.push(" This was emailed when it happened.");
  const title: MailInline[] =
    row.kind === "backup" ? [...rowName(row, ctx), " failed"] : [FAILED_TITLE[row.kind][0], ...rowName(row, ctx), FAILED_TITLE[row.kind][1]];
  return {
    kind: "callout",
    tone: "bad",
    title,
    body,
    action: row.appId ? { label: `Open ${row.appName}'s backups`, href: appPage(ctx, row.appId, "backups") } : undefined,
  };
}

function shrunkCallout(row: BackupSummaryRow, nightly: boolean, ctx: MailContext): MailBlock {
  const drop = row.shrunk!;
  const history = row.history ?? [];
  return {
    kind: "callout",
    tone: "warn",
    title: [...rowName(row, ctx), ` is ${Math.round(drop.drop * 100)}% smaller than usual`],
    body: `${formatBytesIec(row.sizeBytes)} ${nightly ? "tonight" : "this run"}, usually ${formatBytesIec(drop.median)}. That can mean the data it copies went missing.`,
    visual: history.length
      ? {
          kind: "columns",
          compact: true,
          columns: [...history, row.sizeBytes].map((value, i) => ({ parts: [{ value, tone: i === history.length ? ("fail" as const) : undefined }] })),
          caption: `Last ${history.length + 1} ${nightly ? "nights" : "runs"}`,
        }
      : undefined,
    action: { label: "Check the volume", href: row.appId ? appPage(ctx, row.appId, "backups") : consolePage(ctx, "/backups") },
  };
}

function skippedCallout(rows: BackupSummaryRow[], ctx: MailContext): MailBlock {
  if (rows.length === 1) {
    const [row] = rows;
    return { kind: "callout", tone: "warn", title: [...rowName(row, ctx), " was skipped"], body: row.error ?? "No reason was given." };
  }
  const body: MailInline[] = [];
  rows.forEach((row, i) => {
    if (i > 0) body.push(". ");
    body.push(...rowName(row, ctx), `: ${row.error ?? "no reason given"}`);
  });
  body.push(".");
  return { kind: "callout", tone: "warn", title: `${plural(rows.length, "volume")} were skipped`, body };
}

function unfinishedCallout(event: BackupSummaryEvent, ctx: MailContext): MailBlock {
  const jobs = event.run.unfinished ?? [];
  const ids = event.run.unfinishedAppIds ?? {};
  const names = linkedList(jobs.map((j) => ({ text: backupJobLabel(j), href: ids[j] ? appPage(ctx, ids[j], "backups") : undefined })));
  return {
    kind: "callout",
    tone: "warn",
    title: `${plural(jobs.length, "job")} didn't finish before the timeout`,
    body: [...names, `. ${jobs.length === 1 ? "It" : "They"} may still be running.`],
    action: { label: "View the run", href: consolePage(ctx, "/backups") },
  };
}

/** One sentence per app: "agents has 17 volumes with no success in 48 hours, 6 of them never." */
function staleCallout(stale: Stale[], ctx: MailContext): MailBlock {
  const tz = ctx.timeZone ?? UTC;
  const byApp = new Map<string, Stale[]>();
  for (const v of stale) byApp.set(v.appName, [...(byApp.get(v.appName) ?? []), v]);
  const body: MailInline[] = [];
  for (const vols of byApp.values()) {
    if (body.length) body.push(" ");
    const [v] = vols;
    if (vols.length === 1) {
      body.push(...rowName(v, ctx), v.lastSuccessAt ? `: last success ${dayAt(v.lastSuccessAt, tz)}.` : ": never backed up.");
      continue;
    }
    const never = vols.filter((x) => !x.lastSuccessAt).length;
    const tail = never === vols.length ? ", none ever backed up." : never ? `, ${never} of them never.` : ".";
    body.push(link(v.appName, v.appId, ctx), ` has ${vols.length} volumes with no success in 48 hours${tail}`);
  }
  return {
    kind: "callout",
    tone: "warn",
    title: stale.length === 1 ? "A volume hasn't backed up in 48 hours" : `${stale.length} volumes haven't backed up in 48 hours`,
    body,
  };
}

/** "Shop / nginx.conf, Search / config.yml" with each app linked. */
function nameList(rows: BackupSummaryRow[], ctx: MailContext): MailInline[] {
  return rows.flatMap((row, i) => [...(i ? [i === rows.length - 1 ? " and " : ", "] : []), ...rowName(row, ctx)]);
}

function resultText(row: BackupSummaryRow): string {
  if (row.outcome === "skipped") return row.error ? `Skipped: ${row.error}` : "Skipped";
  switch (row.kind) {
    case "import":
      return `Imported ${formatBytesIec(row.sizeBytes)}`;
    case "restore":
      return `Restored in ${formatDuration(row.durationMs)}`;
    case "drill":
      return "Restorable";
    default:
      return formatBytesIec(row.sizeBytes);
  }
}

export function backupSummaryMail(event: BackupSummaryEvent, ctx: MailContext): NotificationMailBody {
  const tz = ctx.timeZone ?? UTC;
  const { failed, shrunk, skipped, routine, config, unfinished, stale } = sortRows(event);
  const nightly = event.run.kind === "nightly";
  const problemsOnly = event.run.problemsOnly === true;
  const total = backupRunTotal(event);

  const callouts: MailBlock[] = [
    ...failed.map((r) => failedCallout(r, ctx)),
    ...shrunk.map((r) => shrunkCallout(r, nightly, ctx)),
    ...(skipped.length ? [skippedCallout(skipped, ctx)] : []),
    ...(unfinished.length ? [unfinishedCallout(event, ctx)] : []),
    ...(stale.length ? [staleCallout(stale, ctx)] : []),
  ];
  const tone: MailTone = failed.length ? "fail" : callouts.length ? "warn" : "success";

  const span = `between ${formatClock(new Date(event.windowStart), tz)} and ${clock(event.windowEnd, tz)}`;
  const lead = !total
    ? `Finished ${span}.`
    : unfinished.length
      ? `${event.succeeded} of ${plural(total, "volume")} backed up before the run timed out at ${clock(event.windowEnd, tz)}.`
      : event.succeeded === total
        ? `${total === 1 ? "1 volume" : `All ${total} volumes`} backed up ${span}.`
        : `${event.succeeded} of ${plural(total, "volume")} backed up ${span}.`;
  const blocks: MailBlock[] = [{ kind: "text", text: lead }, ...callouts];

  if (total > 1) {
    const change = sizeChange(event.rows);
    const missed = event.failed + (event.skipped - routine.length);
    const tiles: StatTile[] = [
      {
        label: "Backed up",
        value: String(event.succeeded),
        unit: `/${total}`,
        sub: unfinished.length
          ? `${unfinished.length} didn't finish`
          : event.failed
            ? `${event.failed} failed`
            : missed
              ? `${missed} skipped`
              : routine.length
                ? `${routine.length} skipped`
                : "volumes",
        hot: event.succeeded < total - routine.length,
      },
      {
        label: "Size",
        ...tileParts(formatBytesIec(event.totalSize)),
        sub: change === undefined ? undefined : pct(change) === "same" ? `same as last ${nightly ? "night" : "run"}` : `${pct(change)} from last ${nightly ? "night" : "run"}`,
      },
      {
        label: "Took",
        ...tileParts(formatDuration(event.run.actualMs)),
        sub: unfinished.length ? "then timed out" : event.run.estimatedMs ? `usually ${formatDuration(event.run.estimatedMs)}` : undefined,
      },
    ];
    blocks.push({ kind: "tiles", tiles });
  }

  if (!problemsOnly) {
    const apps = event.apps ?? summarizeApps(event.rows);
    const changes = apps.some((a) => a.change !== undefined);
    if (apps.length > 1 || (apps.length === 1 && apps[0].volumes > 1)) {
      blocks.push({
        kind: "stats",
        columns: ["App", "Volumes", "Size", ...(changes ? ["Change"] : [])],
        // Apps with nothing backed up show in the callouts and notes instead.
        rows: apps.filter((a) => a.failed || a.volumes > a.skipped).map((a) => ({
          name: a.appName,
          href: a.appId ? appPage(ctx, a.appId, "backups") : undefined,
          why: a.failed ? `${a.failed} failed` : undefined,
          cells: [String(a.volumes), formatBytesIec(a.sizeBytes), ...(changes ? [a.change === undefined ? "—" : pct(a.change)] : [])],
        })),
      });
    }
    for (const kind of ["restore", "import", "drill"] as const) {
      const ofKind = event.rows.filter((r) => r.kind === kind && r.outcome !== "failed");
      if (!ofKind.length) continue;
      blocks.push({ kind: "section", title: KIND_TITLES[kind] });
      blocks.push({
        kind: "stats",
        columns: ["Volume", "Result"],
        rows: ofKind.map((r) => ({ name: rowText(r), href: r.appId ? appPage(ctx, r.appId, "backups") : undefined, cells: [resultText(r)] })),
      });
    }
    if (routine.length) blocks.push({ kind: "note", text: ["Skipped as usual: ", ...nameList(routine, ctx), "."] });
  }
  if (config.length) blocks.push({ kind: "note", text: ["Not backed up — app config the engine leaves out: ", ...nameList(config, ctx), "."] });
  if (event.hiddenRows) blocks.push({ kind: "note", text: `${plural(event.hiddenRows, "more result")} not listed.` });

  const action: MailLink = { label: problemsOnly ? "View the full run" : "View backups", href: consolePage(ctx, "/backups") };
  return {
    tone,
    status: failed.length ? "Backup failed" : tone === "warn" ? "Check backups" : "Backed up",
    heading: event.run.label,
    preheader: lead,
    blocks,
    action,
    footer: footerFor(ctx),
  };
}
