import { and, eq, inArray, like, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import type { DeletableBackup } from "./delete-backups";

/** Archives from before age encryption. Restore refuses them. */
const RETIRED_SUFFIX = "%.enc";

const slot = (jobId: string | null, volumeName: string | null) => `${jobId ?? ""}|${volumeName ?? ""}`;

export type RetiredJob = {
  jobId: string | null;
  jobName: string | null;
  volumeName: string | null;
  archives: number;
  bytes: number;
  replaced: boolean;
};

/**
 * Finished backups still in the retired .enc format, grouped by job and volume.
 * A volume is replaced once its job has a successful .age backup of it. Only replaced archives are deletable unless includeUnreplaced.
 */
export async function findRetiredArchives(opts: { includeUnreplaced?: boolean } = {}) {
  const rows = await db
    .select({
      id: backups.id,
      targetId: backups.targetId,
      status: backups.status,
      storagePath: backups.storagePath,
      jobId: backups.jobId,
      jobName: backups.jobName,
      volumeName: backups.volumeName,
      sizeBytes: backups.sizeBytes,
    })
    .from(backups)
    .where(and(like(backups.storagePath, RETIRED_SUFFIX), notInArray(backups.status, ["pending", "running"])));

  const jobIds = [...new Set(rows.map((r) => r.jobId).filter((id): id is string => !!id))];
  const replaced = new Set(
    jobIds.length
      ? (
          await db
            .selectDistinct({ jobId: backups.jobId, volumeName: backups.volumeName })
            .from(backups)
            .where(and(inArray(backups.jobId, jobIds), eq(backups.status, "success"), like(backups.storagePath, "%.age")))
        ).map((r) => slot(r.jobId, r.volumeName))
      : [],
  );

  const jobs = new Map<string, RetiredJob>();
  const deletable: DeletableBackup[] = [];
  for (const row of rows) {
    const key = slot(row.jobId, row.volumeName);
    const isReplaced = !!row.jobId && replaced.has(key);
    const groupKey = row.jobId ? key : `name:${row.jobName ?? ""}|${row.volumeName ?? ""}`;
    const job = jobs.get(groupKey) ?? {
      jobId: row.jobId,
      jobName: row.jobName,
      volumeName: row.volumeName,
      archives: 0,
      bytes: 0,
      replaced: isReplaced,
    };
    job.archives++;
    job.bytes += row.status === "success" ? (row.sizeBytes ?? 0) : 0;
    jobs.set(groupKey, job);
    if (isReplaced || opts.includeUnreplaced) deletable.push({ id: row.id, targetId: row.targetId, status: row.status, storagePath: row.storagePath });
  }
  return { jobs: [...jobs.values()], deletable };
}
