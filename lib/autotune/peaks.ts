// Highest per-container memory use per app over a window, from the metrics store.

import { isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { readSeries } from "@/lib/metrics/resource-samples";
import { appResourceScope, seriesInScope, type ScopedApp } from "@/lib/metrics/resource-scope";

/** Peak bytes per app id; null when no samples were in scope. Never throws. */
export async function peakMemory(subjects: ScopedApp[], fromMs: number, toMs: number): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>(subjects.map((s) => [s.id, null]));
  if (subjects.length === 0) return out;
  try {
    const [series, topLevel] = await Promise.all([
      readSeries(["memory"], fromMs, toMs),
      db.select({ name: apps.name }).from(apps).where(isNull(apps.parentAppId)),
    ]);
    const known = new Set(topLevel.map((a) => a.name));
    const memory = series.get("memory");
    for (const subject of subjects) {
      let peak = 0;
      for (const s of seriesInScope(memory, appResourceScope(subject, known))) {
        for (const [, value] of s.points) peak = Math.max(peak, value);
      }
      out.set(subject.id, peak > 0 ? peak : null);
    }
  } catch {
    // Metrics are optional; callers treat null as no data.
  }
  return out;
}
