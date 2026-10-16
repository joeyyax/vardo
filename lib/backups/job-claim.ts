// One run of a backup job at a time across consoles: the claim's holder runs it, anyone else reuses that run.

import { randomUUID } from "crypto";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { BACKUP_LEASE_HEARTBEAT_MS, BACKUP_LEASE_TTL_MS } from "./run-lease";

const log = logger.child("backup");

/** `initial` is a first snapshot, `import` a data import into one of the job's apps. */
export type JobClaimer = "manual" | "scheduled" | "initial" | "import";

export type JobClaim = { by: JobClaimer; startedAt: Date };

export type ReleaseClaim = () => Promise<void>;

/** How often a waiter checks whether the claim is free. */
const CLAIM_POLL_MS = 5_000;

export const jobClaimKey = (jobId: string) => `backup:job-claim:${jobId}`;

// Renews the claim, takes it back once it lapsed, or returns the other holder's value.
const RENEW_SCRIPT = `local v = redis.call("get", KEYS[1])
if v == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) end
if not v then redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2]) return 1 end
return v`;
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

function parseClaim(raw: string): JobClaim | null {
  try {
    const { by, startedAt } = JSON.parse(raw) as { by: JobClaimer; startedAt: string };
    return { by, startedAt: new Date(startedAt) };
  } catch {
    return null;
  }
}

const describeClaim = (c: JobClaim | null) => (c ? `a ${c.by} run from ${c.startedAt.toISOString()}` : "an unknown run");

/** Takes the job's claim and keeps it renewed until released. Null when someone else holds it. */
export async function claimJob(
  jobId: string,
  by: JobClaimer,
  startedAt = new Date(),
  heartbeatMs = BACKUP_LEASE_HEARTBEAT_MS,
): Promise<ReleaseClaim | null> {
  const key = jobClaimKey(jobId);
  const value = JSON.stringify({ by, startedAt: startedAt.toISOString(), token: randomUUID() });
  if ((await redis.set(key, value, "PX", BACKUP_LEASE_TTL_MS, "NX")) !== "OK") return null;
  let warned: string | null = null;
  const renew = async () => {
    const other = await redis.eval(RENEW_SCRIPT, 1, key, value, BACKUP_LEASE_TTL_MS);
    if (typeof other !== "string" || other === warned) return;
    warned = other;
    log.warn(`Job ${jobId}'s claim lapsed and ${describeClaim(parseClaim(other))} holds it while ${describeClaim({ by, startedAt })} still runs`);
  };
  const timer = setInterval(() => {
    renew().catch(() => {});
  }, heartbeatMs);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await redis.eval(RELEASE_SCRIPT, 1, key, value).catch(() => {});
  };
}

/** Who holds the job's claim and since when. Null when it's free. */
export async function jobClaimHolder(jobId: string): Promise<JobClaim | null> {
  const raw = await redis.get(jobClaimKey(jobId));
  return raw ? parseClaim(raw) : null;
}

/** Takes the job's claim, waiting while someone else holds it. */
export async function claimJobWhenFree(jobId: string, by: JobClaimer, pollMs = CLAIM_POLL_MS): Promise<ReleaseClaim> {
  for (;;) {
    const release = await claimJob(jobId, by);
    if (release) return release;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
