// Detects subprocessors from settings and stores what the operator decides about them.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs, backupTargets, domains, trustSettings, trustSubprocessors } from "@/lib/db/schema";
import { getEmailProviderConfig } from "@/lib/system-settings";
import { probeReach } from "@/lib/domains/reach";
import { effectiveHosting, getTrustSettings, providerLabel } from "./store";
import { findProvider, locationLabel } from "./hosting";
import {
  detectBackupTarget,
  detectCloudflare,
  detectEmail,
  detectHostingProvider,
  reconcile,
  type Detected,
  type SubprocessorRow,
  type SubprocessorStatus,
} from "./subprocessors";

const CLOUDFLARE_RECHECK_MS = 6 * 60 * 60_000;
const PROBE_DOMAINS = 6;

/** Whether Cloudflare fronts any of the instance's domains. Probes at most every six hours. */
async function cloudflareBehind(now: Date): Promise<boolean> {
  const { cloudflare } = (await db.query.trustSettings.findFirst({ where: eq(trustSettings.id, "instance") })) ?? {};
  if (cloudflare && now.getTime() - new Date(cloudflare.checkedAt).getTime() < CLOUDFLARE_RECHECK_MS) return cloudflare.behind;

  const rows = await db
    .selectDistinct({ domain: domains.domain, isPrimary: domains.isPrimary })
    .from(domains)
    .where(and(eq(domains.enabled, true), eq(domains.source, "vardo")));
  const hosts = [...new Set(rows.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)).map((r) => r.domain))].slice(0, PROBE_DOMAINS);
  const probes = await Promise.all(hosts.map((host) => probeReach(host).catch(() => null)));
  const behind = probes.some((p) => p?.proxy === "cloudflare");
  const next = { behind, checkedAt: now.toISOString() };
  await db
    .insert(trustSettings)
    .values({ id: "instance", cloudflare: next })
    .onConflictDoUpdate({ target: trustSettings.id, set: { cloudflare: next } });
  return behind;
}

export async function detectSubprocessors(now = new Date()): Promise<Detected[]> {
  const [settings, jobs, email] = await Promise.all([
    getTrustSettings(),
    db.select({ targetId: backupJobs.targetId }).from(backupJobs).where(eq(backupJobs.enabled, true)),
    getEmailProviderConfig().catch(() => null),
  ]);
  const targetIds = [...new Set(jobs.map((j) => j.targetId))];
  const targets = targetIds.length ? await db.select().from(backupTargets).where(inArray(backupTargets.id, targetIds)) : [];
  const hosting = effectiveHosting(settings);
  const provider = hosting ? findProvider(hosting.provider) : null;

  const found = [
    detectHostingProvider(hosting ? { provider: providerLabel(hosting), region: locationLabel(provider, hosting) } : null),
    ...targets.map(detectBackupTarget),
    detectEmail(email),
    detectCloudflare(await cloudflareBehind(now).catch(() => false)),
  ];
  const byKey = new Map<string, Detected>();
  for (const d of found) if (d) byKey.set(d.key, d);
  return [...byKey.values()];
}

export async function readSubprocessors(): Promise<SubprocessorRow[]> {
  const rows = await db.select().from(trustSubprocessors).orderBy(asc(trustSubprocessors.name));
  return rows.map((r) => ({ ...r, status: r.status as SubprocessorStatus }));
}

/** Applies a detection to the stored rows. Never confirms anything. */
export async function syncSubprocessors(now = new Date()): Promise<void> {
  const [existing, detected] = await Promise.all([readSubprocessors(), detectSubprocessors(now)]);
  const plan = reconcile(existing, detected);
  const at = new Date();
  if (plan.insert.length) await db.insert(trustSubprocessors).values(plan.insert.map((d) => ({ ...d, status: "suggested", detected: true }))).onConflictDoNothing();
  for (const r of plan.refresh) await db.update(trustSubprocessors).set({ name: r.name, purpose: r.purpose, region: r.region, updatedAt: at }).where(eq(trustSubprocessors.id, r.id));
  if (plan.back.length) await db.update(trustSubprocessors).set({ detected: true, updatedAt: at }).where(inArray(trustSubprocessors.id, plan.back));
  if (plan.gone.length) await db.update(trustSubprocessors).set({ detected: false, updatedAt: at }).where(inArray(trustSubprocessors.id, plan.gone));
  if (plan.drop.length) await db.delete(trustSubprocessors).where(inArray(trustSubprocessors.id, plan.drop));
}

export type SubprocessorInput = { name: string; purpose: string; region: string | null };

export async function addSubprocessor(input: SubprocessorInput): Promise<void> {
  await db.insert(trustSubprocessors).values({ ...input, key: null, status: "confirmed", detected: false });
}

export async function updateSubprocessor(id: string, patch: Partial<SubprocessorInput> & { status?: SubprocessorStatus }): Promise<boolean> {
  const rows = await db.update(trustSubprocessors).set({ ...patch, updatedAt: new Date() }).where(eq(trustSubprocessors.id, id)).returning({ id: trustSubprocessors.id });
  return rows.length > 0;
}

/** Removes a subprocessor from the page. A detected one is dismissed so detection doesn't suggest it again. */
export async function removeSubprocessor(id: string): Promise<boolean> {
  const row = (await readSubprocessors()).find((r) => r.id === id);
  if (!row) return false;
  if (row.key && row.detected) return updateSubprocessor(id, { status: "dismissed" });
  await db.delete(trustSubprocessors).where(eq(trustSubprocessors.id, id));
  return true;
}
