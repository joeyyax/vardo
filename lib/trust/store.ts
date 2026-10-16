import { asc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { trustChecks, trustRuns, trustSettings } from "@/lib/db/schema";
import type { StoredCommitment, StoredCommitments, CommitmentId } from "./commitments";
import { findProvider, manualHosting, type Hosting } from "./hosting";
import { weightsOf, type HistoryRun, type Score } from "./score";
import { CHECK_IDS, VISIBILITIES, type CheckId, type CheckResult, type CheckState, type Judgement, type Visibility } from "./types";

const ROW_ID = "instance";

export type TrustSettings = {
  visibility: Visibility;
  domain: string | null;
  name: string | null;
  commitments: StoredCommitments;
  hostingOverride: { provider: string; region: string } | null;
  hostingDetected: { provider: string; region: string | null; location: string | null } | null;
};

export function parseVisibility(raw: unknown): Visibility {
  return (VISIBILITIES as readonly unknown[]).includes(raw) ? (raw as Visibility) : "off";
}

export async function getTrustSettings(): Promise<TrustSettings> {
  const row = await db.query.trustSettings.findFirst({ where: eq(trustSettings.id, ROW_ID) });
  return {
    visibility: parseVisibility(row?.visibility),
    domain: row?.domain ?? null,
    name: row?.name ?? null,
    commitments: (row?.commitments ?? {}) as StoredCommitments,
    hostingOverride: row?.hostingOverride ?? null,
    hostingDetected: row?.hostingDetected ?? null,
  };
}

export type TrustSettingsPatch = Partial<Pick<TrustSettings, "visibility" | "hostingOverride" | "domain" | "name">>;

export async function updateTrustSettings(patch: TrustSettingsPatch): Promise<TrustSettings> {
  const set = { ...patch, updatedAt: new Date() };
  await db.insert(trustSettings).values({ id: ROW_ID, ...set }).onConflictDoUpdate({ target: trustSettings.id, set });
  return getTrustSettings();
}

/** Merges one commitment's switch or value into the stored set. */
export async function setCommitment(id: CommitmentId, patch: StoredCommitment): Promise<void> {
  const current = (await getTrustSettings()).commitments;
  const commitments = { ...current, [id]: { ...current[id], ...patch } };
  await db.insert(trustSettings).values({ id: ROW_ID, commitments }).onConflictDoUpdate({
    target: trustSettings.id,
    set: { commitments, updatedAt: new Date() },
  });
}

export async function saveDetectedHosting(detected: TrustSettings["hostingDetected"]): Promise<void> {
  await db.insert(trustSettings).values({ id: ROW_ID, hostingDetected: detected }).onConflictDoUpdate({
    target: trustSettings.id,
    set: { hostingDetected: detected },
  });
}

/** The hosting the checks use: the operator's entry, else the last detection. */
export function effectiveHosting(settings: Pick<TrustSettings, "hostingOverride" | "hostingDetected">): Hosting | null {
  if (settings.hostingOverride) return manualHosting(settings.hostingOverride);
  const d = settings.hostingDetected;
  return d ? { provider: d.provider, region: d.region, location: d.location, source: "detected" } : null;
}

export function providerLabel(hosting: Hosting): string {
  return findProvider(hosting.provider)?.name ?? hosting.provider;
}

export async function readResults(): Promise<CheckResult[]> {
  const rows = await db.select().from(trustChecks);
  const known = new Set<string>(CHECK_IDS);
  return rows
    .filter((r) => known.has(r.id))
    .map((r) => ({ id: r.id as CheckId, state: r.state as CheckState, evidence: r.evidence, fix: r.fix, credit: r.credit, checkedAt: r.checkedAt }));
}

export async function writeResults(results: Record<CheckId, Judgement>, at = new Date()): Promise<void> {
  for (const id of CHECK_IDS) {
    const { state, evidence, fix = null, credit = null } = results[id];
    await db
      .insert(trustChecks)
      .values({ id, state, evidence, fix, credit, checkedAt: at })
      .onConflictDoUpdate({ target: trustChecks.id, set: { state, evidence, fix, credit, checkedAt: at } });
  }
}

export const HISTORY_DAYS = 30;
const DAY_MS = 86_400_000;

/** Stores the run's score and check weights, and drops runs older than the history window. */
export async function recordRun(score: Pick<Score, "score" | "max">, at = new Date()): Promise<void> {
  await db.insert(trustRuns).values({ ranAt: at, score: score.score, max: score.max, weights: weightsOf() });
  await db.delete(trustRuns).where(lt(trustRuns.ranAt, new Date(at.getTime() - (HISTORY_DAYS + 1) * DAY_MS)));
}

export async function readHistory(now = new Date()): Promise<HistoryRun[]> {
  const rows = await db
    .select()
    .from(trustRuns)
    .where(gte(trustRuns.ranAt, new Date(now.getTime() - HISTORY_DAYS * DAY_MS)))
    .orderBy(asc(trustRuns.ranAt));
  return rows.map((r) => ({ ranAt: r.ranAt, score: r.score, max: r.max, weights: r.weights }));
}

export async function clearResults(): Promise<void> {
  await db.delete(trustChecks);
  await db.delete(trustRuns);
}
