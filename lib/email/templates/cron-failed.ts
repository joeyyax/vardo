import type { CronFailedEvent } from "@/lib/bus/events";
import { describeSchedule } from "@/lib/cron/describe";
import { formatDayTime, UTC } from "@/lib/time-zone";
import { truncate } from "../format";
import { capLogLines, type MailBlock, type MailFact, type NotificationMailBody } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";

/** A failure explained in a title and one sentence. */
export type CronCause = { title: string; body?: string };

const ERROR_LINE = /\b(error|fatal|panic|exception|failed|denied|refused|not found)\b/i;
const TITLE_MAX = 120;

const EXIT_MEANING: Record<number, CronCause> = {
  124: { title: "The command timed out", body: "timeout stopped it before it finished (exit 124)." },
  126: { title: "The command isn't executable", body: "The shell found it but couldn't run it (exit 126). Check its permissions." },
  127: { title: "Command not found", body: "The shell couldn't find it in the container (exit 127). Check the path or the image." },
  137: { title: "The process was killed", body: "Exit 137 is SIGKILL, usually the container's memory limit." },
  143: { title: "The process was stopped", body: "Exit 143 is SIGTERM, usually a restart or deploy mid-run." },
};

/** The first line that reads like the error, as an index into `lines`. */
export function firstErrorLine(lines: string[]): number {
  return lines.findIndex((l) => ERROR_LINE.test(l));
}

/** "128 MB" from a byte count. */
function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** "wpdb" from ".../wp-includes/class-wpdb.php". */
function phpSource(line: string): string | undefined {
  const file = line.match(/ in (\S+\.php)/)?.[1]?.split("/").pop();
  return file?.replace(/^class-/, "").replace(/\.php$/, "");
}

/** The cause, when the output or exit code says it plainly. */
export function cronCause(event: CronFailedEvent, lines: string[]): CronCause | null {
  const wp = /^\s*wp\s/.test(event.command ?? "");
  for (const line of lines) {
    const mem = line.match(/Allowed memory size of (\d+) bytes exhausted/);
    if (mem) {
      const where = phpSource(line);
      return {
        title: "PHP ran out of memory",
        body: `It hit PHP's ${megabytes(Number(mem[1]))} limit${where ? ` in ${where}` : ""}. Raise memory_limit${wp ? " for WP-CLI" : ""} or trim what the ${wp ? "event" : "job"} loads.`,
      };
    }
    const time = line.match(/Maximum execution time of (\d+) seconds? exceeded/);
    if (time) return { title: "PHP hit its time limit", body: `It ran past max_execution_time (${time[1]}s). Raise the limit or split the work.` };
    if (/JavaScript heap out of memory/.test(line)) {
      return { title: "Node ran out of memory", body: "It hit V8's heap limit. Raise --max-old-space-size or trim what the job loads." };
    }
  }
  if (event.exitCode === undefined) return null;
  if (event.jobType === "url") {
    if (event.exitCode >= 500) return { title: `The URL returned ${event.exitCode}`, body: "The app errored while handling the request. Its logs have the cause." };
    if (event.exitCode === 404) return { title: "The URL returned 404", body: "Nothing answers at that path. Check the URL." };
    if (event.exitCode === 401 || event.exitCode === 403) return { title: `The URL returned ${event.exitCode}`, body: "The app refused the request. Check the job's headers or credentials." };
    return null;
  }
  return EXIT_MEANING[event.exitCode] ?? null;
}

/** Cause if known, else the first error line, else what exited. */
function headline(event: CronFailedEvent, lines: string[], errorAt: number): CronCause {
  const cause = cronCause(event, lines);
  if (cause) return cause;
  const exit = event.exitCode === undefined ? undefined : event.jobType === "url" ? `HTTP ${event.exitCode}.` : `Exit code ${event.exitCode}.`;
  if (errorAt >= 0) return { title: truncate(lines[errorAt].trim(), TITLE_MAX), body: exit };
  if (event.exitCode === undefined) return { title: "The run failed" };
  return event.jobType === "url" ? { title: `The URL returned ${event.exitCode}` } : { title: `The command exited with code ${event.exitCode}` };
}

/** "Every 15 minutes · last success Oct 9, 16:45 UTC". */
function scheduleFact(event: CronFailedEvent, tz: string): MailFact {
  const date = event.lastSuccessAt ? new Date(event.lastSuccessAt) : undefined;
  const ok = date && !Number.isNaN(date.getTime()) ? formatDayTime(date, tz) : undefined;
  if (!event.schedule) return { label: "Last success", value: ok ?? "None on record" };
  const plain = describeSchedule(event.schedule);
  const zone = event.scheduleTimeZone ? `, ${event.scheduleTimeZone}` : "";
  const value = `${plain.charAt(0).toUpperCase()}${plain.slice(1)}${zone} · ${ok ? `last success ${ok}` : "no success on record"}`;
  return { label: "Schedule", value };
}

export function cronFailedMail(event: CronFailedEvent, ctx: MailContext): NotificationMailBody {
  const appId = event.appId;
  const app = event.projectName || "its app";
  const url = event.jobType === "url";
  const tz = ctx.timeZone ?? UTC;
  const history = appId ? appPage(ctx, appId, "cron") : consolePage(ctx, "/cron");

  const lines = capLogLines(event.logTail?.length ? event.logTail : event.message.split("\n"));
  const errorAt = firstErrorLine(lines);
  const cause = headline(event, lines, errorAt);

  const facts: MailFact[] = [];
  if (appId) facts.push({ label: "App", value: app, href: appPage(ctx, appId) });
  if (url && event.target) {
    const link = /^https?:\/\//i.test(event.target) ? event.target : undefined;
    facts.push({ label: "URL", value: event.target, mono: true, href: link });
  } else if (event.command) {
    facts.push({ label: "Command", value: event.command, rich: [{ text: event.command, mono: true }] });
  }
  facts.push(scheduleFact(event, tz));

  const runs = event.recentRuns ?? [];
  const blocks: MailBlock[] = [
    { kind: "callout", tone: "bad", title: cause.title, body: cause.body, action: { label: "Run history", href: history } },
    ...(runs.length > 1
      ? ([
          { kind: "section", title: `Last ${runs.length} runs` },
          { kind: "days", days: runs.map((r) => (r === "success" ? "ok" : "fail")) },
        ] satisfies MailBlock[])
      : []),
    ...(lines.length ? ([{ kind: "section", title: "Output" }, { kind: "log", lines, highlight: errorAt >= 0 ? [errorAt] : [] }] satisfies MailBlock[]) : []),
  ];

  return {
    tone: "fail",
    status: "Cron failed",
    heading: appId ? `${event.cronJobName} failed on ${app}` : `${event.cronJobName} failed`,
    preheader: cause.body ? `${cause.title}. ${cause.body}` : cause.title,
    blocks,
    facts,
    action: { label: "Open the cron job", href: history },
    links: appId ? [{ label: "App logs", href: appPage(ctx, appId, "logs") }] : [],
    footer: footerFor(ctx),
  };
}
