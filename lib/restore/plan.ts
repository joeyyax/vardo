// Pure planning for a whole-instance restore: which backups, which archives, what order.

import type { StoredObject } from "@/lib/backups/storage-port";
import type { RestoreAppStatus } from "@/lib/db/schema/restore";

/** Where the system job writes Vardo's own database dumps. */
export const SYSTEM_BACKUP_PREFIX = "vardo-system/postgres/";

/** Apps restoring at once, in weight units. A build from source costs two. */
export const RESTORE_BUDGET = 3;
export const BUILD_WEIGHT = 2;
export const PULL_WEIGHT = 1;

export type SystemBackup = { key: string; takenAt: Date; sizeBytes: number };

/** The timestamp the engine writes into a storage key, as a Date. */
export function backupTimeFromKey(key: string): Date | null {
  const m = key.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** System database dumps in a listing, newest first. */
export function systemBackupsFrom(objects: StoredObject[]): SystemBackup[] {
  return objects
    .filter((o) => o.key.startsWith(SYSTEM_BACKUP_PREFIX) && o.key.endsWith(".dump.gz"))
    .map((o) => ({ key: o.key, takenAt: backupTimeFromKey(o.key) ?? o.modifiedAt, sizeBytes: o.sizeBytes }))
    .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

export type KeyCheck =
  /** The archive was written with the entered key, and it's the key this instance runs. */
  | { kind: "match"; keyId: string }
  /** A plaintext archive. Nothing to compare, so the restore proceeds on the running key. */
  | { kind: "unencrypted"; keyId: string }
  /** The entered key isn't the one the archive was written with. */
  | { kind: "wrong-key"; archiveKeyId: string; enteredKeyId: string }
  /** The entered key is right, but this instance was started with a different one. */
  | { kind: "not-loaded"; keyId: string; runningKeyId: string | null };

/** Compare the Key IDs of the archive, the entered key and the running key. */
export function checkKeyIds(args: {
  archiveKeyId: string | null;
  enteredKeyId: string;
  runningKeyId: string | null;
}): KeyCheck {
  const { archiveKeyId, enteredKeyId, runningKeyId } = args;
  if (archiveKeyId && archiveKeyId !== enteredKeyId) {
    return { kind: "wrong-key", archiveKeyId, enteredKeyId };
  }
  if (runningKeyId !== enteredKeyId) {
    return { kind: "not-loaded", keyId: enteredKeyId, runningKeyId };
  }
  return archiveKeyId ? { kind: "match", keyId: enteredKeyId } : { kind: "unencrypted", keyId: enteredKeyId };
}

export type ArchiveRow = {
  id: string;
  appId: string;
  appName: string;
  volumeName: string;
  strategy: "tar" | "dump";
  finishedAt: Date;
};

/** For each app volume, its archives at or before `at`, newest first. */
export function archivesAsOf(rows: ArchiveRow[], at: Date): Map<string, ArchiveRow[]> {
  const byVolume = new Map<string, ArchiveRow[]>();
  for (const row of rows) {
    if (row.finishedAt.getTime() > at.getTime()) continue;
    const key = `${row.appId}:${row.volumeName}`;
    const list = byVolume.get(key) ?? [];
    list.push(row);
    byVolume.set(key, list);
  }
  for (const list of byVolume.values()) list.sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());
  return byVolume;
}

export type QueueUnit = {
  appId: string;
  name: string;
  projectId: string | null;
  priority: "critical" | "standard" | "disposable";
  /** App names this one depends on, within its project. */
  dependsOn: string[];
};

const PRIORITY_RANK = { critical: 0, standard: 1, disposable: 2 } as const;

/**
 * Queue order: priority first, dependencies before their dependents.
 * A dependency takes the most urgent priority of anything waiting on it.
 */
export function orderQueue(units: QueueUnit[]): { appId: string; position: number; dependsOn: string[] }[] {
  const byProjectName = new Map(units.map((u) => [`${u.projectId}:${u.name}`, u]));
  const deps = new Map<string, string[]>();
  for (const u of units) {
    const ids = u.dependsOn
      .map((name) => byProjectName.get(`${u.projectId}:${name}`)?.appId)
      .filter((id): id is string => !!id && id !== u.appId);
    deps.set(u.appId, [...new Set(ids)]);
  }

  // Depth in the dependency graph. Cycles are cut where they're found.
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(-1, ...(deps.get(id) ?? []).map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  const rank = new Map(units.map((u) => [u.appId, PRIORITY_RANK[u.priority]] as const));
  // Propagate urgency down to dependencies until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    for (const u of units) {
      for (const dep of deps.get(u.appId) ?? []) {
        if (rank.get(dep)! > rank.get(u.appId)!) {
          rank.set(dep, rank.get(u.appId)!);
          changed = true;
        }
      }
    }
  }

  const sorted = [...units].sort(
    (a, b) =>
      rank.get(a.appId)! - rank.get(b.appId)! ||
      depthOf(a.appId) - depthOf(b.appId) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      a.name.localeCompare(b.name),
  );
  return sorted.map((u, i) => ({ appId: u.appId, position: i, dependsOn: deps.get(u.appId) ?? [] }));
}

export type QueueItem = {
  appId: string;
  status: RestoreAppStatus;
  position: number;
  weight: number;
  dependsOn: string[];
};

const ACTIVE: RestoreAppStatus[] = ["restoring", "deploying"];

/** Queued apps to start now: in order, dependencies settled, within the budget. */
export function nextRunnable<T extends QueueItem>(items: T[], budget = RESTORE_BUDGET): T[] {
  const status = new Map(items.map((i) => [i.appId, i.status]));
  let used = items.filter((i) => ACTIVE.includes(i.status)).reduce((sum, i) => sum + i.weight, 0);
  const picked: T[] = [];
  for (const item of [...items].sort((a, b) => a.position - b.position)) {
    if (item.status !== "queued") continue;
    const waiting = item.dependsOn.some((id) => {
      const s = status.get(id);
      return s === "queued" || (s !== undefined && ACTIVE.includes(s));
    });
    if (waiting) continue;
    // A heavy app still runs alone when nothing else is.
    if (used > 0 && used + item.weight > budget) break;
    picked.push(item);
    used += item.weight;
  }
  // A dependency cycle would wait forever. With nothing running, start the first queued app.
  if (picked.length === 0 && used === 0) {
    const first = [...items].sort((a, b) => a.position - b.position).find((i) => i.status === "queued");
    if (first) picked.push(first);
  }
  return picked;
}

/** New positions with `appId` and its queued dependencies at the front. */
export function moveToFront(items: QueueItem[], appId: string): Map<string, number> {
  const byId = new Map(items.map((i) => [i.appId, i]));
  const lead: string[] = [];
  const visit = (id: string) => {
    const item = byId.get(id);
    if (!item || item.status !== "queued" || lead.includes(id)) return;
    for (const dep of item.dependsOn) visit(dep);
    lead.push(id);
  };
  visit(appId);
  const rest = [...items].sort((a, b) => a.position - b.position).filter((i) => !lead.includes(i.appId));
  return new Map([...lead, ...rest.map((i) => i.appId)].map((id, i) => [id, i]));
}

export type RestoreProgress = { total: number; settled: number; failed: number; deferred: number; active: number };

/** Counts for "12 of 35". Deferred apps count as settled. */
export function progressOf(items: { status: RestoreAppStatus }[]): RestoreProgress {
  const count = (s: RestoreAppStatus) => items.filter((i) => i.status === s).length;
  return {
    total: items.length,
    settled: count("done") + count("failed") + count("deferred"),
    failed: count("failed"),
    deferred: count("deferred"),
    active: count("restoring") + count("deploying"),
  };
}
