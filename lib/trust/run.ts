// Reads each source and records a state per check. Sources are read, never changed.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, backupJobs, backups, backupTargets, domains, passkey, user } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { scheduleIntervalMs } from "@/lib/backups/staleness";
import { githubGet } from "@/lib/github-api";
import { getUpdateStatus } from "@/lib/self-update/status";
import { probeCertificate } from "@/lib/system-alerts/cert-probe";
import { evaluateCertExpiry } from "@/lib/system-alerts/cert-expiry";
import { getProbeGuardSettings, guardKey } from "@/lib/probe-guard/instance";
import { normalizeAppProbeGuard } from "@/lib/probe-guard/settings";
import { detectHosting } from "./hosting";
import { DEFAULT_DATA_ROOT, HOST_MOUNTS_FILE, judgeDiskEncryption, realSys } from "./disk";
import { dockerRequest } from "@/lib/docker/client";
import { readFile } from "fs/promises";
import {
  RESTORE_TEST_WINDOW_MS,
  judgeBackupsProtected,
  judgeHttps,
  judgeNightlyBackups,
  judgeProbeGuard,
  judgeRestoreTested,
  judgeSecurityContact,
  judgeTwoStep,
  judgeUpdated,
  type DomainTls,
  type UpdateReading,
} from "./judge";
import { judgeProviderCert } from "./hosting";
import { computeScore } from "./score";
import { effectiveHosting, getTrustSettings, recordRun, saveDetectedHosting, writeResults } from "./store";
import { CHECK_IDS, type CheckId, type Judgement } from "./types";

const log = logger.child("trust");

const DAY_MS = 86_400_000;
const UPDATE_REPO = "joeyyax/vardo";
const PROBE_CONCURRENCY = 5;

async function readHttps(): Promise<Judgement> {
  const rows = await db
    .selectDistinct({ domain: domains.domain, sslEnabled: domains.sslEnabled })
    .from(domains)
    .where(eq(domains.enabled, true));
  const results: DomainTls[] = [];
  const queue = [...rows];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      if (row.sslEnabled === false) {
        results.push({ domain: row.domain, tls: "no-https", expiresAt: null });
        continue;
      }
      const probe = await probeCertificate(row.domain);
      if (probe.status === "unreachable") {
        results.push({ domain: row.domain, tls: "unreachable", expiresAt: null });
        continue;
      }
      const verdict = evaluateCertExpiry(probe, Date.now());
      const valid = (verdict.kind === "ok" || verdict.kind === "expiring") && probe.authorized;
      results.push({
        domain: row.domain,
        tls: valid ? "valid" : "invalid",
        expiresAt: "expiresAt" in verdict ? new Date(verdict.expiresAt) : null,
      });
    }
  };
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  return judgeHttps(results);
}

async function readNightly(now: Date): Promise<Judgement> {
  const jobs = await db.select({ id: backupJobs.id, name: backupJobs.name, enabled: backupJobs.enabled, schedule: backupJobs.schedule }).from(backupJobs);
  const runs = await db
    .select({ jobId: backups.jobId, status: backups.status, startedAt: backups.startedAt })
    .from(backups)
    .where(gte(backups.startedAt, new Date(now.getTime() - 8 * DAY_MS)));
  return judgeNightlyBackups(
    jobs.map((j) => ({
      name: j.name,
      enabled: j.enabled,
      intervalMs: scheduleIntervalMs(j.schedule, now),
      runs: runs.filter((r) => r.jobId === j.id).map((r) => ({ status: r.status, startedAt: r.startedAt })),
    })),
    now,
  );
}

function isOffHost(target: { type: string; config: unknown }): boolean {
  if (target.type === "local") return false;
  if (target.type === "ssh") {
    const host = String((target.config as { host?: string }).host ?? "").toLowerCase();
    return !["localhost", "127.0.0.1", "::1", ""].includes(host);
  }
  return true;
}

async function readProtected(): Promise<Judgement> {
  const jobs = await db.select({ id: backupJobs.id, name: backupJobs.name, enabled: backupJobs.enabled }).from(backupJobs);
  const latest = await db
    .selectDistinctOn([backups.jobId], {
      jobId: backups.jobId,
      encrypted: backups.encrypted,
      targetType: backupTargets.type,
      targetConfig: backupTargets.config,
    })
    .from(backups)
    .innerJoin(backupTargets, eq(backups.targetId, backupTargets.id))
    .where(and(eq(backups.status, "success"), inArray(backups.jobId, jobs.length ? jobs.map((j) => j.id) : [""])))
    .orderBy(backups.jobId, desc(backups.finishedAt));
  const byJob = new Map(latest.map((l) => [l.jobId, l]));
  return judgeBackupsProtected(
    jobs.map((j) => {
      const l = byJob.get(j.id);
      return {
        name: j.name,
        enabled: j.enabled,
        latest: l ? { encrypted: l.encrypted, offHost: isOffHost({ type: l.targetType, config: l.targetConfig }) } : null,
      };
    }),
  );
}

/** When the commit was made. The update status carries no dates, so this asks GitHub. */
async function readCommitTime(sha: string): Promise<Date | null> {
  try {
    const res = await githubGet(UPDATE_REPO, `/commits/${sha}`, "application/vnd.github+json");
    if (!res.ok) return null;
    const raw = (JSON.parse(res.text) as { commit?: { committer?: { date?: string } } }).commit?.committer?.date;
    const date = raw ? new Date(raw) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

async function readUpdated(now: Date): Promise<Judgement> {
  const status = await getUpdateStatus();
  let reading: UpdateReading;
  if (status.update?.hasUpdate) {
    const auto = status.policy.mode === "auto";
    reading = {
      kind: "behind",
      version: status.current.version,
      target: status.update.targetLabel,
      mode: auto ? "automatic" : status.policy.mode === "notify" ? "notify only" : "off",
      auto,
      targetCommittedAt: auto ? await readCommitTime(status.update.targetSha) : null,
    };
  } else if (status.update) {
    reading = { kind: "current", version: status.current.version };
  } else if (status.noRelease) {
    reading = { kind: "unknown", reason: "The releases channel has nothing published to compare against." };
  } else if (status.checkError) {
    reading = { kind: "unknown", reason: "Vardo couldn't reach GitHub to compare versions." };
  } else {
    reading = { kind: "unknown", reason: "This build has no commit to compare against the channel." };
  }
  return judgeUpdated(reading, now);
}

async function readTwoStep(): Promise<Judgement> {
  const [users, keys] = await Promise.all([
    db.select({ id: user.id, twoFactorEnabled: user.twoFactorEnabled }).from(user),
    db.select({ userId: passkey.userId, n: sql<number>`count(*)::int` }).from(passkey).groupBy(passkey.userId),
  ]);
  const passkeys = new Map(keys.map((k) => [k.userId, k.n]));
  return judgeTwoStep(users.map((u) => ({ twoFactor: !!u.twoFactorEnabled, passkeys: passkeys.get(u.id) ?? 0 })));
}

async function readProbeGuard(): Promise<Judgement> {
  const rows = await db.select({ probeGuard: apps.probeGuard, parentAppId: apps.parentAppId }).from(apps);
  const top = rows.filter((r) => !r.parentAppId);
  return judgeProbeGuard({
    apps: top.length,
    enabled: top.filter((r) => normalizeAppProbeGuard(r.probeGuard).enabled).length,
    keyAvailable: guardKey() !== null,
  });
}

async function readRestoreTested(now: Date): Promise<Judgement> {
  const jobs = await db.select({ id: backupJobs.id, enabled: backupJobs.enabled }).from(backupJobs);
  const rows = await db
    .select({ jobId: backups.jobId, appId: backups.appId, volumeName: backups.volumeName, verifiedAt: backups.verifiedAt, verifyOutcome: backups.verifyOutcome })
    .from(backups)
    .where(and(eq(backups.status, "success"), gte(backups.startedAt, new Date(now.getTime() - 2 * RESTORE_TEST_WINDOW_MS))));
  return judgeRestoreTested(
    jobs,
    rows.filter((r) => r.jobId).map((r) => ({ jobId: r.jobId!, volumeKey: `${r.appId ?? "system"}:${r.volumeName ?? ""}`, verifiedAt: r.verifiedAt, verifyOutcome: r.verifyOutcome })),
    now,
  );
}

async function readDisk(): Promise<Judgement> {
  const [mounts, info] = await Promise.all([
    readFile(HOST_MOUNTS_FILE, "utf8").catch(() => null),
    dockerRequest<{ DockerRootDir?: string }>("GET", "/info").catch(() => null),
  ]);
  return judgeDiskEncryption({ mounts, dataRoot: info?.DockerRootDir || DEFAULT_DATA_ROOT, sys: realSys });
}

async function guarded(id: CheckId, read: () => Promise<Judgement>): Promise<Judgement> {
  try {
    return await read();
  } catch (err) {
    log.error(`Check ${id} failed to run:`, err);
    return { state: "unknown", evidence: "The check couldn't run. See the server log." };
  }
}

/** Runs every check once and stores the results. */
export async function runChecks(now = new Date()): Promise<void> {
  const settings = await getTrustSettings();
  if (!settings.hostingOverride) {
    const detected = await detectHosting().catch(() => null);
    await saveDetectedHosting(detected ? { provider: detected.provider, region: detected.region, location: detected.location } : null);
    settings.hostingDetected = detected ? { provider: detected.provider, region: detected.region, location: detected.location } : null;
  }

  const probeGuardContact = (await getProbeGuardSettings().catch(() => null))?.securityContact ?? "";
  const readers: Record<CheckId, () => Promise<Judgement>> = {
    "security-contact": async () => judgeSecurityContact(probeGuardContact),
    https: readHttps,
    "nightly-backups": () => readNightly(now),
    "backups-protected": readProtected,
    "vardo-updated": () => readUpdated(now),
    "two-step": readTwoStep,
    "probe-guard": readProbeGuard,
    "restore-tested": () => readRestoreTested(now),
    "disk-encrypted": readDisk,
    "provider-cert": async () => judgeProviderCert(effectiveHosting(settings)),
  };

  const entries = await Promise.all(CHECK_IDS.map(async (id) => [id, await guarded(id, readers[id])] as const));
  const judged = Object.fromEntries(entries) as Record<CheckId, Judgement>;
  await writeResults(judged, now);
  await recordRun(computeScore(CHECK_IDS.map((id) => ({ id, ...judged[id], checkedAt: now }))), now);
}
