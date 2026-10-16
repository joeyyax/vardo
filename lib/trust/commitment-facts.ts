// Reads the settings the derived commitments come from.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs } from "@/lib/db/schema";
import { scheduleIntervalMs } from "@/lib/backups/staleness";
import { getUpdatePolicy } from "@/lib/self-update/store";
import { recoveryPointHours, retentionDays, resolveCommitments, type CommitmentFacts, type ResolvedCommitment } from "./commitments";
import { getTrustSettings } from "./store";

export async function readCommitmentFacts(now = new Date()): Promise<CommitmentFacts> {
  const [jobs, policy] = await Promise.all([db.select().from(backupJobs).where(eq(backupJobs.enabled, true)), getUpdatePolicy()]);
  const withInterval = jobs.map((j) => ({ ...j, intervalMs: scheduleIntervalMs(j.schedule, now) }));
  return {
    recoveryPointHours: recoveryPointHours(withInterval.map((j) => j.intervalMs)),
    retentionDays: retentionDays(withInterval),
    autoUpdate: policy.mode === "auto",
  };
}

export async function readCommitments(now = new Date()): Promise<ResolvedCommitment[]> {
  const [settings, facts] = await Promise.all([getTrustSettings(), readCommitmentFacts(now)]);
  return resolveCommitments(settings.commitments, facts);
}
