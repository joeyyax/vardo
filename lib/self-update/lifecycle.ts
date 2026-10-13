// The only sender of Vardo update notices, and the record the "updating" indicator reads. One update id, one incident.

import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import type { BusEvent } from "@/lib/bus/events";
import { emit } from "@/lib/notifications/dispatch";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { openIncident, resolveIncidents, safely } from "@/lib/incidents/store";
import type { IncidentRef } from "@/lib/incidents/types";
import { logger } from "@/lib/logger";
import { acquireLock } from "@/lib/redis-lock";
import { fetchCompare, moreCommits } from "@/lib/version";
import { formatDuration, versionShort } from "@/lib/email/format";
import { seconds, UPDATE_MARKER_MAX_AGE_MS, type UpdateMarker } from "@/lib/lifecycle/classify";

const log = logger.child("self-update");

export const UPDATE_RECORD_KEY = "self_update_current";
/** Written by consoles before the record existed. */
const LEGACY_SEEN_KEY = "lifecycle_update_seen";
export const UPDATE_INCIDENT = "system.update";
/** A running update that hasn't reported in this long has died. */
export const UPDATE_EXPIRES_MS = 60 * 60_000;
/** How long a console that booted mid-update waits for the result. */
export const UPDATE_WAIT_MS = 10 * 60_000;
const CLAIM_TTL_MS = 48 * 60 * 60_000;

export type UpdateFacts = {
  id: string;
  source: "install" | "self-deploy";
  /** Epoch ms. */
  startedAt: number;
  fromVersion: string;
  toVersion?: string;
  branch?: string;
  fromSlot?: string;
  toSlot?: string;
};

export type UpdateRecord = UpdateFacts & {
  state: "running" | "updated" | "failed";
  deadlineAt: number;
  finishedAt?: number;
  /** Notices already sent for this update. */
  notices: string[];
};

export type FinishedReport = Partial<UpdateFacts> & Pick<UpdateFacts, "id"> & {
  finishedAt?: number;
  durationSeconds?: number;
  downSeconds?: number;
};

export type FailedReport = FinishedReport & { step: string; error?: string; rolledBack?: boolean; logTail?: string[] };

async function load(): Promise<UpdateRecord | null> {
  try {
    const row = await db.query.systemSettings.findFirst({ where: (t, { eq }) => eq(t.key, UPDATE_RECORD_KEY) });
    return row ? (JSON.parse(row.value) as UpdateRecord) : null;
  } catch {
    return null;
  }
}

async function save(record: UpdateRecord): Promise<void> {
  const value = JSON.stringify(record);
  await db
    .insert(systemSettings)
    .values({ key: UPDATE_RECORD_KEY, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
}

async function legacySeen(id: string): Promise<string[]> {
  const row = await db.query.systemSettings.findFirst({ where: (t, { eq }) => eq(t.key, LEGACY_SEEN_KEY) }).catch(() => null);
  try {
    const seen = row ? (JSON.parse(row.value) as { id?: string; states?: string[] }) : null;
    return seen?.id === id && Array.isArray(seen.states) ? seen.states : [];
  } catch {
    return [];
  }
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** This update's record: the stored one, or a new one. Null for a report about an older update. */
async function recordFor(facts: FinishedReport, now: number): Promise<UpdateRecord | null> {
  const current = await load();
  const known = defined({
    source: facts.source,
    startedAt: facts.startedAt,
    fromVersion: facts.fromVersion,
    toVersion: facts.toVersion,
    branch: facts.branch,
    fromSlot: facts.fromSlot,
    toSlot: facts.toSlot,
  });
  if (current?.id === facts.id) return { ...current, ...known };
  const startedAt = facts.startedAt ?? now;
  if (current && current.startedAt > startedAt) return null;
  return {
    source: "install",
    fromVersion: "unknown",
    ...known,
    id: facts.id,
    startedAt,
    state: "running",
    deadlineAt: startedAt + UPDATE_EXPIRES_MS,
    notices: await legacySeen(facts.id),
  };
}

/** True once per notice across consoles. Sends when Redis can't say. */
async function claim(id: string, notice: string): Promise<boolean> {
  try {
    return (await acquireLock(`self-update:notice:${id}:${notice}`, CLAIM_TTL_MS)) !== null;
  } catch {
    return true;
  }
}

const SHA_IN_LABEL = /(?:^|\()([0-9a-f]{7,40})\)?\s*$/i;

/** The commit in a version label like "0.1.0 (bc2083d)". */
export function labelSha(label: string | undefined): string | undefined {
  return label?.match(SHA_IN_LABEL)?.[1];
}

/** An update that lands where it started: a redeploy of the same commit. */
export function sameVersion(facts: Pick<UpdateFacts, "fromVersion" | "toVersion">): boolean {
  if (!facts.toVersion) return false;
  const from = labelSha(facts.fromVersion)?.toLowerCase();
  const to = labelSha(facts.toVersion)?.toLowerCase();
  return from && to ? to.startsWith(from) || from.startsWith(to) : facts.fromVersion === facts.toVersion;
}

/** The update's commits from GitHub, when both ends are commits. Best effort. */
async function withChanges<E extends Extract<BusEvent, { type: "system.updated" | "system.update-failed" }>>(event: E): Promise<E> {
  const from = labelSha(event.fromVersion);
  const to = labelSha(event.toVersion);
  if (!from || !to) return event;
  const compare = await fetchCompare(from, to).catch(() => null);
  if (!compare?.commits.length) return event;
  return { ...event, commits: compare.commits, ...moreCommits(compare.aheadBy, compare.commits.length), ...(compare.url ? { changesUrl: compare.url } : {}) } as E;
}

/** The fleet rollout that ran this update, when one did. */
async function rolloutOf(record: UpdateRecord): Promise<{ rolloutId?: string }> {
  const { getUpdateRun } = await import("./store");
  const run = await getUpdateRun().catch(() => null);
  return run?.rolloutId && run.deploymentId === record.id ? { rolloutId: run.rolloutId } : {};
}

function incidentTitle(record: UpdateRecord): string {
  return `Updating Vardo${record.toVersion ? ` to ${versionShort(record.toVersion)}` : ""}`;
}

/** Opens the update's incident in an org, or closes it with the result. */
async function incidentFor(orgId: string, record: UpdateRecord, action: "open" | "close", now: Date): Promise<IncidentRef | null> {
  const req = { kind: UPDATE_INCIDENT, about: record.id, severity: "warning" as const, title: incidentTitle(record) };
  if (action === "open") return safely("open", () => openIncident(orgId, req, now), null);
  return safely(
    "resolve",
    async () => {
      const resolved = (await resolveIncidents(orgId, UPDATE_INCIDENT, [record.id], now)).get(record.id);
      if (resolved || !record.notices.includes("started")) return resolved ?? null;
      // A second result after the first closed it: reopens inside the flap window, then closes again.
      await openIncident(orgId, req, now);
      return (await resolveIncidents(orgId, UPDATE_INCIDENT, [record.id], now)).get(record.id) ?? null;
    },
    null,
  );
}

/** Sends one notice for the update to every admin org, once. */
async function announce(record: UpdateRecord, notice: string, event: BusEvent, action: "open" | "close", now: number): Promise<boolean> {
  if (record.notices.includes(notice)) return false;
  const claimed = await claim(record.id, notice);
  record.notices = [...record.notices, notice];
  await save(record);
  if (!claimed) return false;
  try {
    for (const orgId of await adminOrgIds()) {
      const incident = await incidentFor(orgId, record, action, new Date(now));
      emit(orgId, incident ? { ...event, incident } : event);
    }
  } catch (err) {
    log.error(`Couldn't send ${event.type}:`, err);
  }
  log.info(`Update ${record.id}: ${notice}`);
  return true;
}

// Update announcements run one at a time per process.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** Records an update as running and sends "updating" before the switch. Returns whether it sent. */
export function updateStarted(facts: UpdateFacts, opts: { notify?: boolean; now?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  return serialized(async () => {
    const record = await recordFor(facts, now);
    if (!record || record.state !== "running") return false;
    await save(record);
    if (opts.notify === false || sameVersion(record)) return false;
    const event: BusEvent = {
      type: "system.update-started",
      title: `${incidentTitle(record)}…`,
      message: `${incidentTitle(record)} from ${versionShort(record.fromVersion)}.`,
      fromVersion: record.fromVersion,
      toVersion: record.toVersion,
      branch: record.branch,
      fromSlot: record.fromSlot,
      toSlot: record.toSlot,
    };
    return announce(record, "started", event, "open", now);
  });
}

/** Records the update as done and sends "updated" in the same thread. */
export function updateFinished(report: FinishedReport, opts: { now?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  return serialized(async () => {
    const record = await recordFor(report, now);
    if (!record) return false;
    record.state = "updated";
    record.finishedAt = report.finishedAt ?? now;
    await save(record);
    if (sameVersion(record) && !record.notices.includes("started")) {
      log.info(`Update ${record.id} kept ${record.fromVersion}; nothing to announce`);
      return false;
    }
    const durationSeconds = report.durationSeconds ?? seconds(record.startedAt, record.finishedAt);
    const version = record.toVersion ? `${record.fromVersion} → ${record.toVersion}` : record.fromVersion;
    const event = await withChanges({
      type: "system.updated" as const,
      title: "Vardo updated",
      message: `Vardo updated ${version}${durationSeconds !== undefined ? ` in ${formatDuration(durationSeconds * 1000)}` : ""}.`,
      fromVersion: record.fromVersion,
      toVersion: record.toVersion ?? "unknown version",
      fromSlot: record.fromSlot,
      toSlot: record.toSlot,
      durationSeconds,
      downSeconds: report.downSeconds,
      ...(await rolloutOf(record)),
    });
    return announce(record, "updated", event, "close", now);
  });
}

async function fail(record: UpdateRecord, report: FailedReport, now: number): Promise<boolean> {
  record.state = "failed";
  record.finishedAt = report.finishedAt ?? now;
  await save(record);
  // Announced by a console from before this record.
  if (record.notices.includes("failed")) return false;
  const durationSeconds = report.durationSeconds ?? seconds(record.startedAt, record.finishedAt);
  const event = await withChanges({
    type: "system.update-failed" as const,
    title: "Vardo update failed",
    message: `Vardo update failed at ${report.step}${report.error ? `: ${report.error}` : "."}${report.rolledBack ? " Rolled back." : ""}`,
    fromVersion: record.fromVersion,
    toVersion: record.toVersion,
    fromSlot: record.fromSlot,
    toSlot: record.toSlot,
    step: report.step,
    error: report.error,
    durationSeconds,
    rolledBack: report.rolledBack,
    logTail: report.logTail,
    ...(await rolloutOf(record)),
  });
  return announce(record, `failed:${report.step}`, event, "close", now);
}

/** Records the update as failed and sends "failed" in the same thread. One notice per failed step. */
export function updateFailed(report: FailedReport, opts: { now?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  return serialized(async () => {
    const record = await recordFor(report, now);
    return record ? fail(record, report, now) : false;
  });
}

/** An automatic update that didn't start. */
export async function updateSkipped(event: { fromVersion: string; target: string; reasons: string[] }): Promise<void> {
  try {
    for (const orgId of await adminOrgIds()) {
      emit(orgId, { type: "system.update-skipped", title: "Vardo update skipped", message: event.reasons.join("; "), ...event });
    }
  } catch (err) {
    log.error("Couldn't send system.update-skipped:", err);
  }
}

export type ActiveUpdate = Pick<UpdateRecord, "id" | "fromVersion" | "toVersion" | "startedAt">;

/** The update running now, or null. Expires on its own if the update dies. */
export async function activeUpdate(now = Date.now()): Promise<ActiveUpdate | null> {
  const record = await load();
  if (!record || record.state !== "running" || now >= record.deadlineAt) return null;
  return { id: record.id, fromVersion: record.fromVersion, toVersion: record.toVersion, startedAt: record.startedAt };
}

/** A console that booted mid-update gives it UPDATE_WAIT_MS more to report. */
export function awaitResult(now = Date.now()): Promise<void> {
  return serialized(async () => {
    const record = await load();
    if (!record || record.state !== "running") return;
    record.deadlineAt = Math.min(record.deadlineAt, now + UPDATE_WAIT_MS);
    await save(record);
  });
}

/** Fails a running update past its deadline. Returns whether it did. */
export function reconcileUpdate(now = Date.now()): Promise<boolean> {
  return serialized(async () => {
    const record = await load();
    if (!record || record.state !== "running" || now < record.deadlineAt) return false;
    log.warn(`Update ${record.id} didn't report a result`);
    return fail(record, { id: record.id, step: "the update", error: "The update didn't report a result. Check the install log." }, now);
  });
}

export type MarkerContext = {
  /** This console's hostname. */
  host: string;
  /** When this console's process started, epoch ms. */
  processStartedAt: number;
  /** How long the console was down before this boot. */
  downSeconds?: number;
  now?: number;
};

/** install.sh's entry point: update.json, from either writer. Returns the notice sent. */
export async function ingestUpdateMarker(marker: UpdateMarker | null, ctx: MarkerContext): Promise<UpdateMarker["state"] | null> {
  if (!marker) return null;
  const now = ctx.now ?? Date.now();
  if (now - (marker.finishedAt ?? marker.startedAt) > UPDATE_MARKER_MAX_AGE_MS) return null;
  const facts: UpdateFacts = {
    id: marker.id,
    source: marker.kind === "self-deploy" ? "self-deploy" : "install",
    startedAt: marker.startedAt,
    fromVersion: marker.fromVersion,
    toVersion: marker.toVersion,
    branch: marker.branch,
    fromSlot: marker.fromSlot,
    toSlot: marker.toSlot,
  };
  switch (marker.state) {
    case "started":
      // A console that started after the update did is past the switch.
      return (await updateStarted(facts, { notify: marker.startedAt >= ctx.processStartedAt, now })) ? "started" : null;
    case "updated":
      // The console that ran a self-deploy stops next; the new one reports.
      if (marker.kind === "self-deploy" && marker.fromHost === ctx.host) return null;
      return (await updateFinished(
        { ...facts, finishedAt: marker.finishedAt, downSeconds: seconds(marker.swapStartedAt, marker.healthyAt) ?? ctx.downSeconds },
        { now },
      ))
        ? "updated"
        : null;
    case "failed":
      return (await updateFailed(
        {
          ...facts,
          finishedAt: marker.finishedAt,
          step: marker.step ?? "an unknown step",
          error: marker.error,
          rolledBack: marker.rolledBack,
          logTail: marker.logTail,
        },
        { now },
      ))
        ? "failed"
        : null;
  }
}
