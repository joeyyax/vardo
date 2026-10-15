// A running backup holds a lease its process renews. A row whose lease lapsed belongs to a dead process.

import { redis } from "@/lib/redis";

export const BACKUP_LEASE_TTL_MS = 30 * 1000;

/** Three beats fit inside the lease, so two may be missed. */
export const BACKUP_LEASE_HEARTBEAT_MS = 10 * 1000;

export const backupLeaseKey = (backupId: string) => `backup:lease:${backupId}`;

/** Held by the process a run's job is queued in, from the run's start until the job reports. */
export const runJobLeaseKey = (runId: string, jobId: string) => `backup:run-job:lease:${runId}:${jobId}`;

async function holdLease(key: string): Promise<() => Promise<void>> {
  const renew = () => redis.set(key, String(process.pid), "PX", BACKUP_LEASE_TTL_MS).catch(() => {});
  await renew();
  const timer = setInterval(renew, BACKUP_LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await redis.del(key).catch(() => {});
  };
}

/** Take the lease and keep renewing it. Call the result to release. Never throws. */
export function holdBackupLease(backupId: string): Promise<() => Promise<void>> {
  return holdLease(backupLeaseKey(backupId));
}

/** Take a run job's lease and keep renewing it. Call the result to release. Never throws. */
export function holdRunJobLease(runId: string, jobId: string): Promise<() => Promise<void>> {
  return holdLease(runJobLeaseKey(runId, jobId));
}

/** Whether some live process holds the backup's lease. Throws when Redis can't say. */
export async function backupLeaseHeld(backupId: string): Promise<boolean> {
  return (await redis.exists(backupLeaseKey(backupId))) > 0;
}

/** Whether some live process holds the run job's lease. Throws when Redis can't say. */
export async function runJobLeaseHeld(runId: string, jobId: string): Promise<boolean> {
  return (await redis.exists(runJobLeaseKey(runId, jobId))) > 0;
}
