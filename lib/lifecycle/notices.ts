// The only sender of Vardo's stop, start and restart notices. One incident per stop or restart.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import type { BusEvent, VardoRestartScope } from "@/lib/bus/events";
import { emitConfirmed } from "@/lib/notifications/dispatch";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { openIncident, resolveIncidents, safely } from "@/lib/incidents/store";
import type { IncidentRef } from "@/lib/incidents/types";
import { logger } from "@/lib/logger";
import { LIFECYCLE_DIR } from "@/lib/paths";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { formatDuration } from "@/lib/email/format";
import { WATCHDOG_EVENTS_FILE, newWatchdogEvents, type WatchdogEvent } from "@/lib/system-alerts/watchdog-events";
import { seconds, type BootClassification, type Heartbeat, type ShutdownMarker } from "./classify";

const log = logger.child("lifecycle");

export const RESTARTS_KEY = "lifecycle_restarts";
export const OUTBOX_DIR = join(LIFECYCLE_DIR, "outbox");
/** Written by the vardo wrapper before `vardo stop` and `vardo restart`. */
export const STOP_REASON_FILE = join(LIFECYCLE_DIR, "stop-reason.json");
export const STOP_INCIDENT = "system.lifecycle.stop";
export const RESTART_INCIDENT = "system.lifecycle.restart";
/** How long a SIGTERM handler waits on a notice before leaving it to the next boot. */
export const SHUTDOWN_SEND_BUDGET_MS = 3_000;
/** A restart not back within this long didn't come back. */
export const RESTART_DEADLINE_MS = 5 * 60_000;
/** Services get this long before a restart's health counts. */
export const RESTART_SETTLE_MS = 15_000;
/** A stop reason or watchdog restart this old belongs to an earlier stop. */
const RECENT_MS = 2 * 60_000;
const CLAIM_TTL_MS = 48 * 60 * 60_000;
/** A send stuck this long is left for the next flush, so it can't hold up the rest. */
const DELIVER_TIMEOUT_MS = 30_000;
const KEEP_FINISHED_MS = 24 * 60 * 60_000;

export const DEFAULT_STOP_REASON = "Stop signal: host shutdown, restart or container stop";

/** A notice as written to the outbox: everything delivery needs, in order of `at`. */
export type Notice = {
  /** Claim key: one send per key across consoles. */
  key: string;
  at: number;
  event: BusEvent;
  incident?: { kind: string; about: string; title: string; action: "open" | "close" };
};

export type RestartRecord = VardoRestartScope & {
  id: string;
  services?: string[];
  startedAt: number;
  deadlineAt: number;
  state: "running" | "restarted" | "failed";
  finishedAt?: number;
};

// Delivery

async function incidentFor(orgId: string, spec: NonNullable<Notice["incident"]>, now: Date): Promise<IncidentRef | null> {
  if (spec.action === "open") {
    return safely("open", () => openIncident(orgId, { kind: spec.kind, about: spec.about, severity: "warning", title: spec.title }, now), null);
  }
  return safely("resolve", async () => (await resolveIncidents(orgId, spec.kind, [spec.about], now)).get(spec.about) ?? null, null);
}

/** Sends a notice to every admin org once. Throws when it couldn't, releasing the claim for a retry. */
async function deliver(notice: Notice): Promise<void> {
  const lockKey = `lifecycle:notice:${notice.key}`;
  let token: string | null;
  try {
    token = await acquireLock(lockKey, CLAIM_TTL_MS);
  } catch {
    token = "unclaimed";
  }
  if (!token) return;
  try {
    for (const orgId of await adminOrgIds()) {
      const incident = notice.incident ? await incidentFor(orgId, notice.incident, new Date()) : null;
      await emitConfirmed(orgId, incident ? { ...notice.event, incident } : notice.event);
    }
    log.info(`Sent ${notice.event.type} (${notice.key})`);
  } catch (err) {
    if (token !== "unclaimed") await releaseLock(lockKey, token).catch(() => false);
    throw err;
  }
}

const fileFor = (notice: Notice) => join(OUTBOX_DIR, `${String(notice.at).padStart(14, "0")}-${notice.key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

async function enqueue(notice: Notice): Promise<boolean> {
  try {
    await mkdir(OUTBOX_DIR, { recursive: true });
    const file = fileFor(notice);
    await writeFile(`${file}.${process.pid}.tmp`, JSON.stringify(notice), { mode: 0o644 });
    await rename(`${file}.${process.pid}.tmp`, file);
    return true;
  } catch (err) {
    log.warn("Couldn't write the lifecycle outbox:", err);
    return false;
  }
}

// One flush at a time per process keeps the order.
let flushing: Promise<boolean> = Promise.resolve(true);

/** Sends what's in the outbox, oldest first, stopping at the first failure. Returns whether it emptied. */
export function flushOutbox(): Promise<boolean> {
  const run = flushing.then(flushOnce, flushOnce);
  flushing = run.catch(() => false);
  return run;
}

async function flushOnce(): Promise<boolean> {
  let names: string[];
  try {
    names = (await readdir(OUTBOX_DIR)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return true;
  }
  for (const name of names) {
    const file = join(OUTBOX_DIR, name);
    let notice: Notice;
    try {
      notice = JSON.parse(await readFile(file, "utf-8")) as Notice;
    } catch {
      // Another console sent it, or a partial write.
      continue;
    }
    try {
      await Promise.race([
        deliver(notice),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), DELIVER_TIMEOUT_MS).unref()),
      ]);
    } catch (err) {
      log.warn(`Couldn't send ${notice.event.type}; kept for the next try:`, err);
      return false;
    }
    await rm(file, { force: true });
  }
  return true;
}

/** Queues notices durably, then sends the outbox. Without an outbox it sends directly. */
async function send(notices: Notice[], budgetMs?: number): Promise<void> {
  const queued = (await Promise.all(notices.map(enqueue))).every(Boolean);
  const attempt = queued
    ? flushOutbox()
    : notices.reduce<Promise<unknown>>((p, n) => p.then(() => deliver(n)), Promise.resolve()).then(() => true);
  const guarded = attempt.catch((err) => log.warn("Lifecycle notice failed:", err));
  if (budgetMs === undefined) {
    await guarded;
    return;
  }
  await Promise.race([guarded, new Promise<void>((resolve) => setTimeout(resolve, budgetMs).unref())]);
}

// Restart records

async function loadRestarts(): Promise<Record<string, RestartRecord>> {
  try {
    const row = await db.query.systemSettings.findFirst({ where: (t, { eq }) => eq(t.key, RESTARTS_KEY) });
    return row ? (JSON.parse(row.value) as Record<string, RestartRecord>) : {};
  } catch {
    return {};
  }
}

async function saveRestarts(records: Record<string, RestartRecord>, now: number): Promise<void> {
  const kept = Object.fromEntries(Object.entries(records).filter(([, r]) => r.state === "running" || now - (r.finishedAt ?? r.startedAt) < KEEP_FINISHED_MS));
  const value = JSON.stringify(kept);
  await db
    .insert(systemSettings)
    .values({ key: RESTARTS_KEY, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
}

let restartQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = restartQueue.then(fn, fn);
  restartQueue = run.catch(() => {});
  return run;
}

function scope(r: RestartRecord): VardoRestartScope {
  return { target: r.target, label: r.label, source: r.source, ...(r.reason ? { reason: r.reason } : {}) };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function restartingNotice(r: RestartRecord): Notice {
  return {
    key: `${r.id}:restarting`,
    at: r.startedAt,
    event: { type: "system.restarting", title: `Restarting ${r.label}`, message: `Restarting ${r.label}${r.reason ? `: ${r.reason}` : ""}.`, ...scope(r) },
    incident: { kind: RESTART_INCIDENT, about: r.id, title: `Restarting ${r.label}`, action: "open" },
  };
}

function resultNotice(r: RestartRecord, error?: string): Notice {
  const durationSeconds = seconds(r.startedAt, r.finishedAt);
  const took = durationSeconds !== undefined ? ` in ${formatDuration(durationSeconds * 1000)}` : "";
  const event: BusEvent = error
    ? { type: "system.restart-failed", title: `${capitalize(r.label)} didn't come back`, message: error, error, durationSeconds, ...scope(r) }
    : { type: "system.restarted", title: `${capitalize(r.label)} restarted`, message: `${capitalize(r.label)} restarted${took}.`, durationSeconds, ...scope(r) };
  return {
    key: `${r.id}:${error ? "failed" : "restarted"}`,
    // Always after its "Restarting" in the outbox.
    at: Math.max(r.finishedAt ?? Date.now(), r.startedAt + 1),
    event,
    incident: { kind: RESTART_INCIDENT, about: r.id, title: `Restarting ${r.label}`, action: "close" },
  };
}

export type RestartRequest = VardoRestartScope & { id?: string; services?: string[]; startedAt?: number };

/** Records a restart and sends "Restarting". A budget bounds the wait, for a console about to stop. Returns its id. */
export function restartStarted(req: RestartRequest, opts: { now?: number; budgetMs?: number } = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  const startedAt = req.startedAt ?? now;
  const id = req.id ?? `restart-${req.target}-${startedAt}`;
  return serialized(async () => {
    const records = await loadRestarts();
    if (records[id]) return id;
    const record: RestartRecord = {
      target: req.target,
      label: req.label,
      source: req.source,
      ...(req.reason ? { reason: req.reason } : {}),
      ...(req.services ? { services: req.services } : {}),
      id,
      startedAt,
      deadlineAt: startedAt + RESTART_DEADLINE_MS,
      state: "running",
    };
    records[id] = record;
    await saveRestarts(records, now).catch((err) => log.warn("Couldn't record the restart:", err));
    await send([restartingNotice(record)], opts.budgetMs);
    return id;
  });
}

async function finish(records: Record<string, RestartRecord>, record: RestartRecord, now: number, error?: string): Promise<void> {
  if (record.state !== "running") return;
  record.state = error ? "failed" : "restarted";
  record.finishedAt = now;
  await saveRestarts(records, now).catch((err) => log.warn("Couldn't record the restart:", err));
  // Sends the start too when nothing did, so the pair stays whole.
  await send([restartingNotice(record), resultNotice(record, error)]);
}

/** Closes a restart with "restarted" or "didn't come back". A restart never recorded gets the whole pair. */
export function restartFinished(
  idOrReq: string | RestartRequest,
  outcome: { error?: string } = {},
  opts: { now?: number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now();
  return serialized(async () => {
    const records = await loadRestarts();
    const req = typeof idOrReq === "string" ? null : idOrReq;
    const id = typeof idOrReq === "string" ? idOrReq : idOrReq.id ?? `restart-${idOrReq.target}-${idOrReq.startedAt ?? now}`;
    let record = records[id];
    if (!record) {
      const startedAt = req?.startedAt ?? now;
      record = {
        target: req?.target ?? "console",
        label: req?.label ?? "Vardo",
        source: req?.source ?? "console",
        ...(req?.reason ? { reason: req.reason } : {}),
        ...(req?.services ? { services: req.services } : {}),
        id,
        startedAt,
        deadlineAt: startedAt + RESTART_DEADLINE_MS,
        state: "running",
      };
      records[id] = record;
    }
    await finish(records, record, now, outcome.error);
  });
}

type ServiceContainer = { service: string; state: string; status: string };

/** What's still not back for a services restart: missing, stopped, unhealthy or starting. */
export function servicesNotBack(services: string[], containers: ServiceContainer[]): string[] {
  return services.filter((service) => {
    const c = containers.find((x) => x.service === service);
    if (!c || c.state !== "running") return true;
    return /\((unhealthy|health: starting)\)/.test(c.status);
  });
}

async function sharedContainers(): Promise<ServiceContainer[]> {
  const { listContainers } = await import("@/lib/docker/client");
  return (await listContainers())
    .filter((c) => c.labels["com.docker.compose.project"] === "vardo")
    .map((c) => ({ service: c.labels["com.docker.compose.service"] ?? "", state: c.state, status: c.status }));
}

/** Closes services restarts once they're back, and fails any restart past its deadline. */
export function reconcileRestarts(now = Date.now()): Promise<void> {
  return serialized(async () => {
    const records = await loadRestarts();
    for (const record of Object.values(records)) {
      if (record.state !== "running") continue;
      if (record.target === "services" && record.services?.length && now - record.startedAt >= RESTART_SETTLE_MS) {
        const missing = servicesNotBack(record.services, await sharedContainers().catch(() => []));
        if (missing.length === 0) {
          await finish(records, record, now);
          continue;
        }
        if (now >= record.deadlineAt) {
          const minutes = Math.round(RESTART_DEADLINE_MS / 60_000);
          await finish(records, record, now, `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} back ${minutes} minutes after the restart.`);
        }
        continue;
      }
      if (now >= record.deadlineAt) await finish(records, record, now, `${capitalize(record.label)} didn't report back after the restart.`);
    }
  });
}

/** The restart running now, for the banner. Null once it finishes or passes its deadline. */
export async function activeRestart(now = Date.now()): Promise<Pick<RestartRecord, "id" | "label" | "startedAt"> | null> {
  const running = Object.values(await loadRestarts())
    .filter((r) => r.state === "running" && now < r.deadlineAt)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  return running ? { id: running.id, label: running.label, startedAt: running.startedAt } : null;
}

// Watchdog

const WATCHDOG_TARGETS: Record<string, { target: "console" | "worker"; label: string }> = {
  console: { target: "console", label: "Vardo" },
  worker: { target: "worker", label: "the Vardo worker" },
};

async function watchdogEvents(): Promise<WatchdogEvent[]> {
  try {
    return newWatchdogEvents(await readFile(WATCHDOG_EVENTS_FILE, "utf-8"), 0);
  } catch {
    return [];
  }
}

/** The watchdog's newest "restarting" for a role between two times (epoch ms). */
export async function watchdogRestarting(role: string, fromMs: number, toMs: number): Promise<WatchdogEvent | null> {
  const events = (await watchdogEvents()).filter((e) => e.role === role && e.action === "restarting" && e.ts * 1000 >= fromMs && e.ts * 1000 <= toMs);
  return events[events.length - 1] ?? null;
}

const watchdogId = (e: WatchdogEvent) => `watchdog-${e.role}-${e.ts}`;

/** Turns a watchdog event about the console or worker into its restart notices. False for anything else. */
export async function watchdogEvent(event: WatchdogEvent, now = Date.now()): Promise<boolean> {
  const target = WATCHDOG_TARGETS[event.role];
  if (!target || event.action === "backoff") return false;
  const reason = `Unhealthy for ${event.fails} checks in a row`;
  const base: RestartRequest = { ...target, source: "watchdog", reason };
  if (event.action === "restarting") {
    await restartStarted({ ...base, id: watchdogId(event), startedAt: event.ts * 1000 }, { now });
    return true;
  }
  // The restart this result belongs to: the newest watchdog restart of the role just before it.
  const from = event.ts * 1000 - RECENT_MS;
  const recorded = Object.values(await loadRestarts())
    .filter((r) => r.source === "watchdog" && r.target === target.target && r.startedAt >= from && r.startedAt <= event.ts * 1000)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const logged = recorded ? null : await watchdogRestarting(event.role, from, event.ts * 1000);
  const id = recorded?.id ?? (logged ? watchdogId(logged) : watchdogId(event));
  const startedAt = recorded?.startedAt ?? (logged ?? event).ts * 1000;
  await restartFinished({ ...base, id, startedAt }, event.action === "restart-failed" ? { error: `The watchdog couldn't restart ${event.container}.` } : {}, { now });
  return true;
}

// Stop and start

export type StopPlan = { id: string; kind: "stop" | "restart"; reason: string };

async function stopReason(now: number): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(STOP_REASON_FILE, "utf-8")) as { reason?: unknown; at?: unknown };
    await rm(STOP_REASON_FILE, { force: true });
    const at = typeof raw.at === "number" ? (raw.at < 1e12 ? raw.at * 1000 : raw.at) : 0;
    return typeof raw.reason === "string" && raw.reason.trim() && now - at < RECENT_MS ? raw.reason.trim().slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** Why this console is stopping, and the thread it belongs to. Reads only; sends nothing. */
export async function planStop(signalReason: string | null, now = Date.now()): Promise<StopPlan> {
  const pending = Object.values(await loadRestarts()).find((r) => r.target === "console" && r.state === "running" && now < r.deadlineAt);
  if (pending) return { id: pending.id, kind: "restart", reason: `Restart: ${pending.label}` };
  const watchdog = await watchdogRestarting("console", now - RECENT_MS, now + 5_000);
  if (watchdog) return { id: watchdogId(watchdog), kind: "restart", reason: "Watchdog restart" };
  return { id: `stop-${now}`, kind: "stop", reason: (await stopReason(now)) ?? signalReason ?? DEFAULT_STOP_REASON };
}

/** Sends this console's stop notice within the shutdown budget; the outbox keeps it for the next boot otherwise. */
export async function consoleStopping(plan: StopPlan, info: { version: string; uptimeSeconds: number; now?: number }): Promise<void> {
  const now = info.now ?? Date.now();
  if (plan.kind === "restart") {
    // An admin restart already sent its start; a watchdog restart sends it now.
    if (plan.id.startsWith("watchdog-")) {
      const ts = Number(plan.id.split("-").pop());
      await restartStarted(
        { id: plan.id, target: "console", label: "Vardo", source: "watchdog", reason: "Unhealthy", startedAt: Number.isFinite(ts) ? ts * 1000 : now },
        { now, budgetMs: SHUTDOWN_SEND_BUDGET_MS },
      ).catch(() => {});
    }
    return;
  }
  await send(
    [
      {
        key: `${plan.id}:stopping`,
        at: now,
        event: {
          type: "system.shutdown",
          title: "Vardo is stopping",
          message: `Vardo is stopping: ${plan.reason}.`,
          reason: plan.reason,
          version: info.version,
          uptimeSeconds: info.uptimeSeconds,
        },
        incident: { kind: STOP_INCIDENT, about: plan.id, title: "Vardo stopped", action: "open" },
      },
    ],
    SHUTDOWN_SEND_BUDGET_MS,
  );
}

function backUp(about: string, boot: Extract<BootClassification, { kind: "clean" | "unclean" }>, version: string, now: number, reason?: string): Notice {
  const down = boot.downSeconds;
  return {
    key: `${about}:back-up`,
    at: now,
    event: {
      type: "system.started",
      title: "Vardo is back up",
      message: `Vardo is back up${down !== undefined ? ` after ${formatDuration(down * 1000)}` : ""}${boot.hostRebooted ? " and a host reboot" : ""}.`,
      version,
      downSeconds: down,
      hostRebooted: boot.hostRebooted,
      ...(reason ? { reason } : {}),
    },
    incident: { kind: STOP_INCIDENT, about, title: "Vardo stopped", action: "close" },
  };
}

/**
 * Sends what's left from before the boot, then this boot's notices.
 * `quiet` when an update or a self-deploy handover already explains it.
 */
export async function consoleBooted(input: {
  boot: BootClassification;
  shutdown: ShutdownMarker | null;
  heartbeat: Heartbeat | null;
  version: string;
  quiet: boolean;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  await flushOutbox();
  const { boot } = input;
  if (input.quiet || boot.kind === "first-boot") return;

  if (boot.kind === "clean") {
    const shutdown = input.shutdown;
    if (shutdown?.kind === "restart" && shutdown.id) {
      await restartFinished(shutdown.id, {}, { now });
      return;
    }
    await send([backUp(shutdown?.id ?? `stop-${shutdown?.at ?? now}`, boot, input.version, now, boot.reason)]);
    return;
  }

  // A hung console the watchdog restarted never ran its shutdown.
  const since = input.heartbeat ? input.heartbeat.at - RECENT_MS : now - RECENT_MS;
  const watchdog = await watchdogRestarting("console", since, now);
  if (watchdog) {
    await restartFinished(
      { id: watchdogId(watchdog), target: "console", label: "Vardo", source: "watchdog", reason: "Unhealthy", startedAt: watchdog.ts * 1000 },
      {},
      { now },
    );
    return;
  }

  const about = `unclean-${input.heartbeat?.at ?? now}`;
  await send([
    {
      key: `${about}:stopped`,
      at: now - 1,
      event: {
        type: "system.recovered-unclean",
        title: "Vardo stopped unexpectedly",
        message: "Vardo stopped without shutting down cleanly: power loss, a forced stop or a crash.",
        version: input.version,
        downSeconds: boot.downSeconds,
        hostRebooted: boot.hostRebooted,
        lastHeartbeatAt: boot.lastHeartbeatAt,
      },
      incident: { kind: STOP_INCIDENT, about, title: "Vardo stopped unexpectedly", action: "open" },
    },
    backUp(about, boot, input.version, now),
  ]);
}

/** Containers running before a host restart that didn't come back. */
export async function containersMissing(missing: { name: string; app?: string; state: string }[], bootId: string): Promise<void> {
  if (missing.length === 0) return;
  await send([
    {
      key: `${bootId}:containers-missing`,
      at: Date.now(),
      event: {
        type: "system.containers-missing",
        title: "Containers didn't come back",
        message: `${missing.length} container(s) were running before the restart and aren't now.`,
        containers: missing,
      },
    },
  ]);
}
