// Reads the settings the generated policies describe.

import { desc, eq, inArray, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs, backups, backupTargets } from "@/lib/db/schema";
import { ALL_AUTH_METHODS, getAuthMethodLayers, resolveAuthMethod } from "@/lib/config/auth-methods";
import { getProbeGuardSettings } from "@/lib/probe-guard/instance";
import { getAuthConfig, getEmailProviderConfig } from "@/lib/system-settings";
import { readCommitments } from "./commitment-facts";
import type { PolicyFacts } from "./policies";
import { getTrustSettings } from "./store";

function offHost(target: { type: string; config: unknown }): boolean {
  if (target.type === "local") return false;
  if (target.type === "ssh") {
    const host = String((target.config as { host?: string }).host ?? "").toLowerCase();
    return !["localhost", "127.0.0.1", "::1", ""].includes(host);
  }
  return true;
}

export async function readPolicyFacts(): Promise<PolicyFacts> {
  const [settings, jobs, commitments, layers, auth, email, guard] = await Promise.all([
    getTrustSettings(),
    db.select().from(backupJobs).where(eq(backupJobs.enabled, true)),
    readCommitments(),
    getAuthMethodLayers(),
    getAuthConfig(),
    getEmailProviderConfig().catch(() => null),
    getProbeGuardSettings().catch(() => null),
  ]);

  const targetIds = [...new Set(jobs.map((j) => j.targetId))];
  const targets = targetIds.length ? await db.select().from(backupTargets).where(inArray(backupTargets.id, targetIds)) : [];
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const latest = jobs.length
    ? await db
        .selectDistinctOn([backups.jobId], { jobId: backups.jobId, encrypted: backups.encrypted })
        .from(backups)
        .where(and(eq(backups.status, "success"), inArray(backups.jobId, jobs.map((j) => j.id))))
        .orderBy(backups.jobId, desc(backups.finishedAt))
    : [];
  const byCommitment = new Map(commitments.map((c) => [c.id, c]));

  return {
    name: settings.name ?? "This operator",
    backup: {
      jobs: jobs.length > 0,
      recoveryPointHours: byCommitment.get("recovery-point")?.amount ?? null,
      retentionDays: byCommitment.get("backup-retention")?.amount ?? null,
      offHost: jobs.length > 0 && jobs.every((j) => { const t = targetById.get(j.targetId); return !!t && offHost(t); }),
      encrypted: jobs.length > 0 && latest.length === jobs.length && latest.every((l) => l.encrypted),
    },
    access: {
      methods: ALL_AUTH_METHODS.filter((m) => resolveAuthMethod(m, layers).enabled).sort(),
      registration: auth.registrationMode,
      sessionDays: auth.sessionDurationDays,
    },
    incident: {
      securityContact: guard?.securityContact?.trim() || null,
      breachNotification: byCommitment.get("breach-notification")?.value ?? null,
      email: !!email,
      backupFailureAlerts: jobs.length > 0 && jobs.every((j) => j.notifyOnFailure),
    },
  };
}
