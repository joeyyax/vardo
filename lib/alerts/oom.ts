// Recent OOM kills per app, fed by every `app.oom-killed` emit in any process through Redis, and the alert they raise.

import type { AlertItem, AlertView } from "@/lib/bus/events";
import { onEmit } from "@/lib/bus";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";
import { formatBytesIec } from "@/lib/metrics/format";
import type { Observation } from "@/lib/notifications/observations";
import { formatClock, zoneAbbreviation } from "@/lib/time-zone";
import { suggestedLimitMb, type LimitOrigin } from "@/lib/autotune/decide";

/** A kill holds its app's alert this long after the last one. */
export const OOM_HOLD_MS = 60 * 60_000;

/** An exited container gets this long to come back before the alert says how it went. */
export const OOM_SETTLE_MS = 2 * 60_000;

const MIB = 1024 * 1024;

export type OomPath = "process" | "exit";

export type OomRecord = {
  organizationId: string;
  appId: string;
  appName: string;
  containers: Map<string, number>;
  containerIds: Set<string>;
  kills: number;
  hostKill: boolean;
  /** `exit` once any kill took the container down. */
  path: OomPath;
  /** Docker's restart count when the first exit was seen. */
  restartBaseline: number | null;
  firstAt: number;
  lastAt: number;
  /** What the Auto profile did about this record, decided once. */
  autotune?: AutotuneNote | null;
  /** The alert went out; later passes only hold it. */
  sent?: boolean;
};

export type OomKill = {
  appId: string;
  appName: string;
  containerName: string;
  containerId?: string;
  kind: "oom-host" | "oom-limit";
  path?: OomPath;
  restartCount?: number | null;
};

const log = logger.child("alerts");

// This process's kills: the fallback when Redis can't be read.
const g = globalThis as unknown as { __vardo_oom_recent?: Map<string, OomRecord> };
const recent: Map<string, OomRecord> = (g.__vardo_oom_recent ??= new Map());

const INDEX_KEY = "alerts:oom:index";
export const oomRecordKey = (organizationId: string, appId: string) => `alerts:oom:rec:${organizationId}:${appId}`;

/** Retries of a kill Redis refused, 10 seconds apart. */
const WRITE_RETRIES = 6;
const WRITE_RETRY_MS = 10_000;

function mergeKill(organizationId: string, kill: OomKill, at: number): void {
  const key = `${organizationId}:${kill.appId}`;
  const record = recent.get(key) ?? {
    organizationId,
    appId: kill.appId,
    appName: kill.appName,
    containers: new Map(),
    containerIds: new Set(),
    kills: 0,
    hostKill: false,
    path: "process",
    restartBaseline: null,
    firstAt: at,
    lastAt: at,
  };
  record.containers.set(kill.containerName, (record.containers.get(kill.containerName) ?? 0) + 1);
  if (kill.containerId) record.containerIds.add(kill.containerId);
  record.kills += 1;
  record.hostKill ||= kill.kind === "oom-host";
  if ((kill.path ?? "exit") === "exit") {
    record.path = "exit";
    if (record.restartBaseline === null && typeof kill.restartCount === "number") record.restartBaseline = kill.restartCount;
  }
  record.lastAt = Math.max(record.lastAt, at);
  recent.set(key, record);
}

async function execAll(multi: ReturnType<typeof redis.multi>): Promise<void> {
  const results = await multi.exec();
  if (!results) throw new Error("Redis transaction aborted");
  const failed = results.find(([err]) => err);
  if (failed) throw failed[0];
}

/** Adds one kill to the app's shared record. Each field is its own atomic update, so writers don't race. */
export async function writeOomKill(organizationId: string, kill: OomKill, at: number): Promise<void> {
  const key = oomRecordKey(organizationId, kill.appId);
  const multi = redis
    .multi()
    .hset(key, "organizationId", organizationId, "appId", kill.appId, "appName", kill.appName)
    .hsetnx(key, "firstAt", at)
    .hset(key, "lastAt", at)
    .hincrby(key, "kills", 1)
    .hincrby(key, `c:${kill.containerName}`, 1);
  if (kill.containerId) multi.hset(key, `i:${kill.containerId}`, 1);
  if (kill.kind === "oom-host") multi.hset(key, "hostKill", 1);
  if ((kill.path ?? "exit") === "exit") {
    multi.hset(key, "path", "exit");
    if (typeof kill.restartCount === "number") multi.hsetnx(key, "restartBaseline", kill.restartCount);
  } else {
    multi.hsetnx(key, "path", "process");
  }
  multi.pexpire(key, OOM_HOLD_MS).sadd(INDEX_KEY, key).pexpire(INDEX_KEY, OOM_HOLD_MS * 2);
  await execAll(multi);
}

function writeWithRetry(organizationId: string, kill: OomKill, at: number, attempt = 0): void {
  writeOomKill(organizationId, kill, at).catch((err) => {
    if (attempt >= WRITE_RETRIES) {
      log.warn(`Gave up sharing the OOM kill of ${kill.appId}; only this process's alert pass sees it:`, err);
      return;
    }
    setTimeout(() => writeWithRetry(organizationId, kill, at, attempt + 1), WRITE_RETRY_MS).unref?.();
  });
}

/** Records a kill here and in Redis, where the alert pass in any process reads it. */
export function recordOomKill(organizationId: string, kill: OomKill, at: number): void {
  mergeKill(organizationId, kill, at);
  writeWithRetry(organizationId, kill, at);
}

/** This process's kills inside the hold window. Older records are dropped. */
export function recentOomKills(now: number): OomRecord[] {
  for (const [key, record] of recent) {
    if (now - record.lastAt > OOM_HOLD_MS) recent.delete(key);
  }
  return [...recent.values()];
}

/** A shared record from its Redis hash; null when the hash is partial. */
export function parseOomRecord(h: Record<string, string>): OomRecord | null {
  if (!h.organizationId || !h.appId || !h.appName || !h.lastAt) return null;
  const containers = new Map<string, number>();
  const containerIds = new Set<string>();
  let autotune: AutotuneNote | null | undefined;
  for (const [field, value] of Object.entries(h)) {
    if (field.startsWith("c:")) containers.set(field.slice(2), Number(value));
    else if (field.startsWith("i:")) containerIds.add(field.slice(2));
  }
  if (h.autotune !== undefined) {
    try {
      autotune = JSON.parse(h.autotune) as AutotuneNote | null;
    } catch {
      autotune = null;
    }
  }
  const lastAt = Number(h.lastAt);
  return {
    organizationId: h.organizationId,
    appId: h.appId,
    appName: h.appName,
    containers,
    containerIds,
    kills: Number(h.kills ?? 0),
    hostKill: h.hostKill === "1",
    path: h.path === "exit" ? "exit" : "process",
    restartBaseline: h.restartBaseline !== undefined ? Number(h.restartBaseline) : null,
    firstAt: Math.min(Number(h.firstAt ?? lastAt), lastAt),
    lastAt,
    ...(autotune !== undefined ? { autotune } : {}),
    ...(h.sent === "1" ? { sent: true } : {}),
  };
}

/** Kills from every process inside the hold window. Falls back to this process's when Redis can't be read. */
export async function sharedOomKills(now: number): Promise<OomRecord[]> {
  try {
    const keys = await redis.smembers(INDEX_KEY);
    if (keys.length === 0) return [];
    const multi = redis.multi();
    for (const key of keys) multi.hgetall(key);
    const results = await multi.exec();
    if (!results) throw new Error("Redis transaction aborted");
    const records: OomRecord[] = [];
    const gone: string[] = [];
    keys.forEach((key, i) => {
      const [err, hash] = results[i];
      if (err) throw err;
      const record = parseOomRecord((hash ?? {}) as Record<string, string>);
      if (!record || now - record.lastAt > OOM_HOLD_MS) gone.push(key);
      else records.push(record);
    });
    if (gone.length > 0) redis.srem(INDEX_KEY, ...gone).catch(() => {});
    return records;
  } catch (err) {
    log.warn("Couldn't read shared OOM kills, using this process's:", err instanceof Error ? err.message : err);
    return recentOomKills(now);
  }
}

/** Sets fields on a shared record that still exists; a lapsed one gets a TTL, never lingers. */
async function updateShared(record: OomRecord, fields: Record<string, string>): Promise<void> {
  const key = oomRecordKey(record.organizationId, record.appId);
  await execAll(redis.multi().hset(key, fields).pexpire(key, OOM_HOLD_MS, "NX"));
}

function localRecord(record: OomRecord): OomRecord | undefined {
  return recent.get(`${record.organizationId}:${record.appId}`);
}

/** The alert went out: later passes in any process only hold it. */
export async function markOomSent(record: OomRecord): Promise<void> {
  record.sent = true;
  const local = localRecord(record);
  if (local) local.sent = true;
  await updateShared(record, { sent: "1" }).catch((err) => log.warn(`Couldn't share the OOM alert state of ${record.appId}:`, err));
}

/** Keeps what the Auto profile did, so no process decides it twice. */
export async function saveOomAutotune(record: OomRecord): Promise<void> {
  const local = localRecord(record);
  if (local) local.autotune = record.autotune;
  await updateShared(record, { autotune: JSON.stringify(record.autotune ?? null) }).catch((err) =>
    log.warn(`Couldn't share the auto-adjust note of ${record.appId}:`, err),
  );
}

export function resetOomKills(): void {
  recent.clear();
}

onEmit("alerts-oom", (organizationId, event) => {
  if (event.type !== "app.oom-killed" || !event.appId) return;
  recordOomKill(organizationId, event, Date.now());
});


/** What the Auto profile did after the kill. */
export type AutotuneNote =
  | { kind: "raised"; toMb: number; live: boolean }
  | { kind: "held"; reason: "rate-limited" | "host-tight" | "at-ceiling" }
  | { kind: "halted"; raises: number };

/** The app's state when the alert is built, read after the kill. */
export type OomFollowup = {
  status: "running" | "down" | "unknown";
  runningSince: Date | null;
  /** Docker restarts since the kill. Null when there was no baseline. */
  dockerRestarts: number | null;
  /** Health monitor restarts since the kill. */
  vardoRestarts: number;
  /** The health monitor hit its restart cap. */
  gaveUp: boolean;
  /** Bytes. 0 is none, null unknown. */
  limitBytes: number | null;
  limitSource: LimitOrigin;
  /** Highest container memory over the last hour, in bytes. */
  peakBytes: number | null;
  timeZone: string;
};

/** "2 GiB". */
function size(bytes: number): string {
  return formatBytesIec(bytes, 1);
}

function mbSize(mb: number): string {
  return size(mb * MIB);
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function clock(date: Date, tz: string): string {
  return `${formatClock(date, tz)} ${zoneAbbreviation(date, tz)}`;
}

const SOURCE_NOTE: Record<LimitOrigin, string> = {
  app: " (set in Vardo)",
  autotune: " (set by the Auto profile)",
  compose: " (set in compose)",
  default: " (Vardo's default; none set in compose)",
  none: "",
  unknown: "",
};

/** "2 GiB limit (Vardo's default; none set in compose)". */
export function limitPhrase(f: Pick<OomFollowup, "limitBytes" | "limitSource">): string | null {
  if (!f.limitBytes) return null;
  return `${size(f.limitBytes)} limit${SOURCE_NOTE[f.limitSource]}`;
}

/** First line: how it died and what happened next. */
export function oomWhatHappened(record: Pick<OomRecord, "path" | "hostKill">, f: OomFollowup): string {
  const limit = limitPhrase(f);
  if (record.path === "process") {
    return record.hostKill || !limit
      ? "The host ran out of memory and the kernel killed a process inside it; the container kept running."
      : `A process inside it hit its ${limit} and was killed; the container kept running.`;
  }
  const how =
    record.hostKill || !limit
      ? `The host ran out of memory and the kernel killed it${f.limitBytes === 0 ? "; it has no limit of its own" : ""}.`
      : `It hit its ${limit} and exited.`;
  return `${how} ${afterKill(f)}`.trim();
}

function afterKill(f: OomFollowup): string {
  if (f.status === "down") {
    return f.gaveUp
      ? `Vardo restarted it ${times(Math.max(1, f.vardoRestarts))} and stopped; it's still down.`
      : "It hasn't come back up.";
  }
  if (f.status !== "running") return "";
  const since = f.runningSince ? `it's been running since ${clock(f.runningSince, f.timeZone)}` : "it's running";
  const docker = f.dockerRestarts ?? 0;
  if (docker > 0) return `Docker restarted it ${times(docker)}; ${since}.`;
  if (f.vardoRestarts > 0) return `Vardo restarted it ${times(f.vardoRestarts)}; ${since}.`;
  return `${since.charAt(0).toUpperCase()}${since.slice(1)}.`;
}

/** The memory the next limit is sized from: a limit kill used at least the whole limit. */
export function sizingPeak(record: Pick<OomRecord, "hostKill">, f: Pick<OomFollowup, "peakBytes" | "limitBytes">): number | null {
  const peak = f.peakBytes ?? 0;
  const floor = record.hostKill ? 0 : (f.limitBytes ?? 0);
  const bytes = Math.max(peak, floor);
  return bytes > 0 ? bytes : null;
}

export function autotuneLine(note: AutotuneNote): string {
  switch (note.kind) {
    case "raised":
      return `Vardo raised the limit to ${mbSize(note.toMb)} (the memory profile is Auto). ${note.live ? "It applies now." : "It applies on the next deploy."}`;
    case "halted":
      return `The Auto profile raised the limit ${times(note.raises)} without it settling and has stopped.`;
    case "held":
      return note.reason === "rate-limited"
        ? "The Auto profile raised the limit in the last 6 hours, so it left it alone this time."
        : note.reason === "host-tight"
          ? "The memory profile is Auto, but the host is short on memory, so Vardo didn't raise the limit."
          : "The memory profile is Auto, but the limit is already at its Auto ceiling.";
  }
}

/** What to do next. */
export function oomNextStep(record: Pick<OomRecord, "hostKill">, f: OomFollowup, note: AutotuneNote | null | undefined): string {
  const peak = sizingPeak(record, f);
  const suggestion = peak ? mbSize(suggestedLimitMb(peak)) : null;
  const advice = record.hostKill
    ? suggestion && !f.limitBytes
      ? `Free memory on the host, or give it a limit of ${suggestion}.`
      : "Free memory on the host, or lower what else runs on it."
    : suggestion
      ? `Raise the limit to ${suggestion}.`
      : "Raise the limit or find what's using more than it was given.";
  if (!note) return advice;
  return note.kind === "raised" ? autotuneLine(note) : `${autotuneLine(note)} ${advice}`;
}

function titleTail(record: Pick<OomRecord, "path">, f: OomFollowup | null): string {
  if (record.path === "process") return " · still running";
  if (f?.status === "running") return " · running again";
  if (f?.status === "down") return " · still down";
  return "";
}

/** The Limit, Peak, Restarts and Status facts. */
export function oomFacts(record: Pick<OomRecord, "path">, f: OomFollowup): { label: string; value: string }[] {
  const restarts = record.path === "process" ? 0 : (f.dockerRestarts ?? 0) + f.vardoRestarts;
  const status =
    f.status === "running"
      ? f.runningSince
        ? `Running since ${clock(f.runningSince, f.timeZone)}`
        : "Running"
      : f.status === "down"
        ? f.gaveUp
          ? "Down, restarts stopped"
          : "Down"
        : "Unknown";
  return [
    { label: "Limit", value: f.limitBytes === null ? "Unknown" : f.limitBytes === 0 ? "None" : `${size(f.limitBytes)}${SOURCE_NOTE[f.limitSource]}` },
    { label: "Peak (1h)", value: f.peakBytes ? size(f.peakBytes) : "No data" },
    { label: "Restarts", value: String(restarts) },
    { label: "Status", value: status },
  ];
}

const SOURCE_CLAUSE: Record<LimitOrigin, string> = {
  app: ", set in Vardo",
  autotune: ", set by the Auto profile",
  compose: ", set in compose",
  default: ", Vardo's default since compose doesn't set one",
  none: "",
  unknown: "",
};

const SOURCE_SHORT: Record<LimitOrigin, string | undefined> = {
  app: "set in Vardo",
  autotune: "set by Auto",
  compose: "set in compose",
  default: "Vardo's default",
  none: undefined,
  unknown: undefined,
};

/** "2 GiB" as a tile: value "2", unit " GiB". */
function tileSize(bytes: number): { value: string; unit: string } {
  const [value, unit] = size(bytes).split(" ");
  return { value, unit: unit ? ` ${unit}` : "" };
}

/** "Docker restarted it at 07:04 PDT." for a running app. */
function backLine(f: OomFollowup): string | undefined {
  if (f.status !== "running") return undefined;
  const at = f.runningSince ? ` at ${clock(f.runningSince, f.timeZone)}` : "";
  if ((f.dockerRestarts ?? 0) > 0) return `Docker restarted it${at}.`;
  if (f.vardoRestarts > 0) return `Vardo restarted it${at}.`;
  return f.runningSince ? `Running since ${clock(f.runningSince, f.timeZone)}.` : undefined;
}

/** What the Auto profile did, or what to do. */
function nextLine(record: Pick<OomRecord, "hostKill">, f: OomFollowup, note: AutotuneNote | null | undefined): string {
  if (note?.kind === "raised") {
    return `Its memory profile is Auto, so Vardo raised the limit to ${mbSize(note.toMb)}, ${note.live ? "starting now" : "from the next deploy"}.`;
  }
  return oomNextStep(record, f, note);
}

/** The email layout: each fact once, status in tiles. */
export function oomView(record: OomRecord, f: OomFollowup, note: AutotuneNote | null | undefined): AlertView {
  const name = record.appName;
  const limit = f.limitBytes ? size(f.limitBytes) : null;
  const hitLimit = !record.hostKill && limit;
  const tiles: NonNullable<AlertView["tiles"]> = [];
  if (f.peakBytes) tiles.push({ label: "Peak", ...tileSize(f.peakBytes), sub: "last hour" });
  if (note?.kind === "raised") tiles.push({ label: "New limit", ...tileSize(note.toMb * MIB), sub: `was ${limit ?? "none"}` });
  else if (f.limitBytes !== null) tiles.push({ label: "Limit", ...(limit ? tileSize(f.limitBytes) : { value: "None", unit: "" }), sub: SOURCE_SHORT[f.limitSource] });
  if (record.kills > 1) tiles.push({ label: "Kills", value: String(record.kills), sub: "last hour" });
  const action = { label: f.limitBytes === 0 ? "Set a limit" : "Change the limit", path: `/apps/${record.appId}/resources` };

  if (record.path === "process") {
    const how = hitLimit ? `A process hit its ${limit} limit${SOURCE_CLAUSE[f.limitSource]} and was killed.` : "The host ran out of memory and the kernel killed one process inside it.";
    return {
      heading: `A process in ${name} was killed for memory`,
      reassure: { strong: "The container kept running." },
      lead: [`${how} ${nextLine(record, f, note)}`],
      brief: {
        title: `${name} lost a process`,
        body: `${hitLimit ? `A process hit the ${limit} limit and was killed.` : "The kernel killed one process inside it."} The container kept running.`,
      },
      tiles,
      action: hitLimit ? action : { label: `Open ${name}`, path: `/apps/${record.appId}` },
    };
  }

  const how = hitLimit
    ? `It hit its ${limit} limit${SOURCE_CLAUSE[f.limitSource]}.`
    : `The host ran out of memory and the kernel killed it.${f.limitBytes === 0 ? " It has no limit of its own." : ""}`;
  const down = f.status === "down" ? (f.gaveUp ? `Vardo restarted it ${times(Math.max(1, f.vardoRestarts))}, then stopped.` : "It hasn't come back up.") : undefined;
  const back = backLine(f);
  const restarts = (f.dockerRestarts ?? 0) + f.vardoRestarts;
  tiles.push({
    label: "Restarts",
    value: String(restarts),
    sub: f.status === "running" ? (f.runningSince ? `running since ${formatClock(f.runningSince, f.timeZone)}` : "running") : f.status === "down" ? (f.gaveUp ? "restarts stopped" : "still down") : undefined,
    hot: f.status === "down",
  });
  const killed = hitLimit
    ? `Killed ${times(record.kills)} at its ${limit} limit.`
    : `Killed ${times(record.kills)}${f.limitBytes === 0 ? " with no limit of its own" : " when the host ran out of memory"}.`;
  return {
    heading: `${name} was killed for memory`,
    reassure: f.status === "running" ? { strong: "It's running again.", text: back } : undefined,
    lead: [[how, down, nextLine(record, f, note)].filter(Boolean).join(" ")],
    brief: {
      title: f.status === "down" ? `${name} is down` : `${name} was killed for memory`,
      body: [killed, down ?? back, note?.kind === "raised" ? `Vardo raised its limit to ${mbSize(note.toMb)}.` : oomNextStep(record, f, note)].filter(Boolean).join(" "),
    },
    tiles,
    action,
  };
}

/** The `app.oom` alert for one record. Without a follow-up it holds the alert but says less. */
export function oomObservation(record: OomRecord, followup: OomFollowup | null = null, now: number = record.lastAt): Observation {
  const containers = [...record.containers].map(([name, n]) => (n > 1 ? `${name} (${n})` : name));
  const settling = record.path === "exit" && now - record.lastAt < OOM_SETTLE_MS;
  const detail = followup
    ? oomWhatHappened(record, followup)
    : record.hostKill
      ? "The host ran out of memory and the kernel killed it. Free memory on the host or give the app a limit."
      : "It hit its own memory limit. Raise the limit or find what's using more than it was given.";
  const item: AlertItem = {
    type: "app.oom",
    about: record.appId,
    appId: record.appId,
    appName: record.appName,
    severity: "critical",
    title: `${record.appName} killed for memory${titleTail(record, followup)}`,
    detail,
    next: followup ? oomNextStep(record, followup, record.autotune) : undefined,
    facts: [
      ...(followup ? oomFacts(record, followup) : []),
      ...(record.kills > 1 ? [{ label: "Kills", value: String(record.kills) }] : []),
      { label: containers.length === 1 ? "Container" : "Containers", value: containers.join(", ") },
    ],
    since: new Date(record.firstAt).toISOString(),
    ...(record.hostKill ? { hostMemory: true } : {}),
    ...(followup ? { view: oomView(record, followup, record.autotune) } : {}),
  };
  return { type: "app.oom", about: record.appId, severity: "critical", fires: !settling, item };
}
