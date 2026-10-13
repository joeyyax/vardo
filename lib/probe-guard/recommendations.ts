// Stack templates a scan recognized in an app, and what the owner did with each.

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { probeRecommendations, type ProbeRecommendationStatus } from "@/lib/db/schema";
import { findTemplate, PROBE_TEMPLATES } from "./templates";

export type RecommendationRow = { status: ProbeRecommendationStatus; templateVersion: number; updated: boolean };
export type RecommendationChange = { status: ProbeRecommendationStatus; templateVersion: number; updated: boolean };

/** What a scan that recognized the template does to its row, or null to leave it. `applied` means the app already has the template. */
export function nextRecommendation(
  existing: RecommendationRow | undefined,
  templateVersion: number,
  applied: boolean,
): RecommendationChange | null {
  if (applied) return existing?.status === "applied" && existing.templateVersion === templateVersion ? null : { status: "applied", templateVersion, updated: false };
  if (!existing) return { status: "pending", templateVersion, updated: false };
  if (existing.status === "ignored") {
    return templateVersion > existing.templateVersion ? { status: "pending", templateVersion, updated: true } : null;
  }
  if (existing.status === "applied") return { status: "pending", templateVersion, updated: false };
  return existing.templateVersion === templateVersion ? null : { status: "pending", templateVersion, updated: existing.updated };
}

/** Records the templates a scan recognized. `applied` lists the template ids the app already has. */
export async function recordRecognized(appId: string, recognized: readonly string[], applied: readonly string[]): Promise<void> {
  const rows = await db.select().from(probeRecommendations).where(eq(probeRecommendations.appId, appId));
  for (const templateId of recognized) {
    const template = findTemplate(templateId);
    if (!template) continue;
    const existing = rows.find((r) => r.templateId === templateId);
    const change = nextRecommendation(existing, template.version, applied.includes(templateId));
    if (!change) continue;
    if (existing) {
      await db
        .update(probeRecommendations)
        .set({ ...change, updatedAt: new Date() })
        .where(eq(probeRecommendations.id, existing.id));
    } else {
      await db.insert(probeRecommendations).values({ id: nanoid(), appId, templateId, ...change });
    }
  }
}

export type RecommendationView = { templateId: string; name: string; description: string; status: ProbeRecommendationStatus; updated: boolean };

/** Every template the app was told about, with its state. */
export async function listRecommendations(appId: string): Promise<RecommendationView[]> {
  const rows = await db.select().from(probeRecommendations).where(eq(probeRecommendations.appId, appId));
  return rows.flatMap((r) => {
    const template = PROBE_TEMPLATES.find((t) => t.id === r.templateId);
    return template ? [{ templateId: r.templateId, name: template.name, description: template.description, status: r.status, updated: r.updated }] : [];
  });
}

/** Records the owner's answer. Ignored sticks until the template's version changes. */
export async function resolveRecommendation(appId: string, templateId: string, status: ProbeRecommendationStatus): Promise<void> {
  const template = findTemplate(templateId);
  if (!template) return;
  await db
    .update(probeRecommendations)
    .set({ status, templateVersion: template.version, updated: false, updatedAt: new Date() })
    .where(and(eq(probeRecommendations.appId, appId), eq(probeRecommendations.templateId, templateId)));
}
