import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { trustChecks, trustSettings } from "@/lib/db/schema";
import { findProvider, manualHosting, type Hosting } from "./hosting";
import { CHECK_IDS, VISIBILITIES, type CheckId, type CheckResult, type CheckState, type Judgement, type Visibility } from "./types";

const ROW_ID = "instance";

export type TrustSettings = {
  visibility: Visibility;
  securityContact: string;
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
    securityContact: row?.securityContact ?? "",
    hostingOverride: row?.hostingOverride ?? null,
    hostingDetected: row?.hostingDetected ?? null,
  };
}

export type TrustSettingsPatch = Partial<Pick<TrustSettings, "visibility" | "securityContact" | "hostingOverride">>;

export async function updateTrustSettings(patch: TrustSettingsPatch): Promise<TrustSettings> {
  const set = { ...patch, updatedAt: new Date() };
  await db.insert(trustSettings).values({ id: ROW_ID, ...set }).onConflictDoUpdate({ target: trustSettings.id, set });
  return getTrustSettings();
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
    .map((r) => ({ id: r.id as CheckId, state: r.state as CheckState, evidence: r.evidence, checkedAt: r.checkedAt }));
}

export async function writeResults(results: Record<CheckId, Judgement>, at = new Date()): Promise<void> {
  for (const id of CHECK_IDS) {
    const { state, evidence } = results[id];
    await db
      .insert(trustChecks)
      .values({ id, state, evidence, checkedAt: at })
      .onConflictDoUpdate({ target: trustChecks.id, set: { state, evidence, checkedAt: at } });
  }
}

export async function clearResults(): Promise<void> {
  await db.delete(trustChecks);
}
