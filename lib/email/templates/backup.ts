import type { BackupRunStartedEvent, BackupSummaryEvent, BackupSummaryRow } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { formatDuration, plural } from "../format";
import type { MailFact, MailTone, MailVisual, NotificationMailBody } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";
import { backupColumns } from "./visuals";

/** Charts for at most this many rows, the worst first. */
const CHARTED_ROWS = 3;

const KIND_NOUNS: Record<BackupSummaryRow["kind"], [string, string]> = {
  backup: ["backup", "backups"],
  restore: ["restore", "restores"],
  import: ["import", "imports"],
  drill: ["restore drill", "restore drills"],
};

/** "1 backup and 1 restore drill failed". */
function failedHeading(failed: BackupSummaryRow[]): string {
  const parts = (["backup", "restore", "import", "drill"] as const).flatMap((kind) => {
    const n = failed.filter((r) => r.kind === kind).length;
    return n ? [plural(n, KIND_NOUNS[kind][0], KIND_NOUNS[kind][1])] : [];
  });
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${list} failed`;
}

const KIND_TITLES: Record<BackupSummaryRow["kind"], string> = {
  backup: "Backed up",
  restore: "Restores",
  import: "Imports",
  drill: "Restore drills",
};

function rowLabel(row: BackupSummaryRow): string {
  return row.appName === row.volumeName ? row.volumeName : `${row.appName} / ${row.volumeName}`;
}

function change(row: BackupSummaryRow): string {
  if (row.previousSize === undefined || row.previousSize <= 0) return "";
  const pct = Math.round(((row.sizeBytes - row.previousSize) / row.previousSize) * 100);
  return pct === 0 ? " · same as last run" : ` · ${pct > 0 ? "+" : ""}${pct}% vs last run`;
}

function rowValue(row: BackupSummaryRow): string {
  const runs = row.runs > 1 ? ` · ${row.runs} runs` : "";
  if (row.outcome === "failed") {
    const what = row.kind === "backup" ? "" : `${KIND_NOUNS[row.kind][0][0].toUpperCase()}${KIND_NOUNS[row.kind][0].slice(1)} failed: `;
    return `${what}${row.error ?? "Failed"}${runs}`;
  }
  if (row.outcome === "skipped") return `Skipped${row.error ? `: ${row.error}` : ""}`;
  switch (row.kind) {
    case "backup":
      return `${formatBytesIec(row.sizeBytes)}${change(row)}${runs}`;
    case "import":
      return `Imported ${formatBytesIec(row.sizeBytes)}`;
    case "restore":
      return `Restored in ${formatDuration(row.durationMs)}`;
    case "drill":
      return "Restorable";
  }
}

function rowFact(row: BackupSummaryRow, ctx: MailContext): MailFact {
  const href = row.outcome === "failed" && row.appId ? appPage(ctx, row.appId, "backups") : undefined;
  return { label: rowLabel(row), value: rowValue(row), href };
}

function timeOfDay(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

export function backupSummaryMail(event: BackupSummaryEvent, ctx: MailContext): NotificationMailBody {
  const failed = event.rows.filter((r) => r.outcome === "failed");
  const shrunk = event.rows.filter((r) => r.shrunk);
  const stale = event.staleVolumes ?? [];
  const backups = event.rows.filter((r) => r.kind === "backup");
  const total = event.succeeded + event.failed + event.skipped;

  const unfinished = event.run.unfinished ?? [];
  const tone: MailTone = failed.length ? "fail" : shrunk.length || stale.length || unfinished.length ? "warn" : "success";
  const heading = failed.length
    ? `${event.run.label}: ${failedHeading(failed)}`
    : `${event.run.label} finished`;

  const paragraphs: string[] = [];
  if (failed.length) paragraphs.push("Each failure was emailed as it happened. The last good backup for each is still there.");
  if (unfinished.length) {
    paragraphs.push(`${plural(unfinished.length, "job")} hadn't finished when this run timed out: ${unfinished.join(", ")}. They may still be running.`);
  }
  if (shrunk.length) paragraphs.push("Some backups came out much smaller than usual. That can mean the data they copy went missing.");
  if (stale.length) paragraphs.push(`${plural(stale.length, "volume")} ${stale.length === 1 ? "hasn't" : "haven't"} had a successful backup in 48 hours.`);

  const visuals: MailVisual[] = [];
  if (total > 1) {
    visuals.push({
      kind: "stacked",
      title: "This run",
      segments: [
        { label: "Succeeded", value: event.succeeded, tone: "success", detail: String(event.succeeded) },
        { label: "Failed", value: event.failed, tone: "fail", detail: String(event.failed) },
        { label: "Skipped", value: event.skipped, tone: 2, detail: String(event.skipped) },
      ],
    });
  }
  for (const row of [...failed, ...shrunk].filter((r) => r.kind === "backup").slice(0, CHARTED_ROWS)) {
    const chart = backupColumns(rowLabel(row), row.history, row.outcome === "failed" ? null : row.sizeBytes);
    if (chart) visuals.push(chart.visual);
  }

  const facts: MailFact[] = [];
  if (backups.length) facts.push({ label: "Backed up", value: `${event.succeeded} of ${total}, ${formatBytesIec(event.totalSize)}` });
  facts.push({
    label: "Took",
    value: `${formatDuration(event.run.actualMs)}${event.run.estimatedMs ? `, estimated ${formatDuration(event.run.estimatedMs)}` : ""}`,
  });
  facts.push({ label: "Ran", value: `${timeOfDay(event.windowStart)}–${timeOfDay(event.windowEnd)} UTC` });

  const sections: { title: string; facts: MailFact[] }[] = [];
  if (failed.length) sections.push({ title: "Failed", facts: failed.map((r) => rowFact(r, ctx)) });
  if (shrunk.length) {
    sections.push({
      title: "Smaller than usual",
      facts: shrunk.map((r) => ({
        label: rowLabel(r),
        value: `${formatBytesIec(r.sizeBytes)}, ${Math.round(r.shrunk!.drop * 100)}% below its usual ${formatBytesIec(r.shrunk!.median)}`,
      })),
    });
  }
  if (stale.length) {
    sections.push({
      title: "No successful backup in 48 hours",
      facts: stale.map((v) => ({
        label: v.appName === v.volumeName ? v.volumeName : `${v.appName} / ${v.volumeName}`,
        value: v.lastSuccessAt ? `Last good ${new Date(v.lastSuccessAt).toISOString().slice(0, 10)}` : "Never succeeded",
      })),
    });
  }
  const rest = event.rows.filter((r) => r.outcome !== "failed" && !r.shrunk);
  for (const kind of ["backup", "restore", "import", "drill"] as const) {
    const ofKind = rest.filter((r) => r.kind === kind);
    if (ofKind.length) sections.push({ title: KIND_TITLES[kind], facts: ofKind.map((r) => rowFact(r, ctx)) });
  }
  if (event.hiddenRows) sections.push({ title: "More", facts: [{ label: "", value: `${event.hiddenRows} more in Backups` }] });

  return {
    tone,
    status: failed.length ? "Backup failed" : tone === "warn" ? "Check backups" : "Backed up",
    heading,
    preheader: failed[0] ? `${rowLabel(failed[0])}: ${failed[0].error ?? "failed"}` : event.message,
    paragraphs,
    visuals,
    facts,
    sections,
    action: { label: "View backups", href: consolePage(ctx, "/backups") },
    footer: footerFor(ctx),
  };
}

/** Volumes listed per app before the rest are counted. */
const LISTED_APPS = 40;

export function backupRunStartedMail(event: BackupRunStartedEvent, ctx: MailContext): NotificationMailBody {
  const facts: MailFact[] = [
    { label: "Covers", value: `${plural(event.volumeCount, "volume")} across ${plural(event.apps.length, "app")}` },
    { label: "Should take", value: event.estimatedMs ? `about ${formatDuration(event.estimatedMs)}` : "No estimate yet, first run" },
  ];
  if (event.target) facts.push({ label: "Writing to", value: event.target });
  const shown = event.apps.slice(0, LISTED_APPS);
  return {
    tone: "info",
    status: "Starting",
    heading: `${event.label} starting`,
    preheader: event.message,
    paragraphs: ["Failures email as they happen. A summary follows when every job is done."],
    facts,
    sections: [
      {
        title: "Backing up",
        facts: [
          ...shown.map((a) => ({ label: a.appName, value: a.volumes.join(", ") })),
          ...(event.apps.length > shown.length ? [{ label: "", value: `and ${plural(event.apps.length - shown.length, "more app")}` }] : []),
        ],
      },
    ],
    action: { label: "View backups", href: consolePage(ctx, "/backups") },
    footer: footerFor(ctx),
  };
}
