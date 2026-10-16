// One run of a backup job at a time across consoles: the claim's holder runs it, anyone else reuses that run.

import { randomUUID } from "crypto";
import { redis } from "@/lib/redis";
import { BACKUP_LEASE_HEARTBEAT_MS, BACKUP_LEASE_TTL_MS } from "./run-lease";

export type JobClaimer = "manual" | "scheduled";

export type JobClaim = { by: JobClaimer; startedAt: Date };

export type ReleaseClaim = () => Promise<void>;

/** How often a waiter checks whether the claim is free. */
const CLAIM_POLL_MS = 5_000;

export const jobClaimKey = (jobId: string) => `backup:job-claim:${jobId}`;

const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Takes the job's claim and keeps it renewed until released. Null when someone else holds it. */
export async function claimJob(jobId: string, by: JobClaimer, startedAt = new Date()): Promise<ReleaseClaim | null> {
  const key = jobClaimKey(jobId);
  const value = JSON.stringify({ by, startedAt: startedAt.toISOString(), token: randomUUID() });
  if ((await redis.set(key, value, "PX", BACKUP_LEASE_TTL_MS, "NX")) !== "OK") return null;
  const timer = setInterval(() => {
    redis.eval(RENEW_SCRIPT, 1, key, value, BACKUP_LEASE_TTL_MS).catch(() => {});
  }, BACKUP_LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await redis.eval(RELEASE_SCRIPT, 1, key, value).catch(() => {});
  };
}

/** Who holds the job's claim and since when. Null when it's free. */
export async function jobClaimHolder(jobId: string): Promise<JobClaim | null> {
  const raw = await redis.get(jobClaimKey(jobId));
  if (!raw) return null;
  try {
    const { by, startedAt } = JSON.parse(raw) as { by: JobClaimer; startedAt: string };
    return { by, startedAt: new Date(startedAt) };
  } catch {
    return null;
  }
}

/** Takes the job's claim, waiting while someone else holds it. */
export async function claimJobWhenFree(jobId: string, by: JobClaimer, pollMs = CLAIM_POLL_MS): Promise<ReleaseClaim> {
  for (;;) {
    const release = await claimJob(jobId, by);
    if (release) return release;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
