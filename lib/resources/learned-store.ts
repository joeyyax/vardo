// Records each app's daily memory p99 and reads learned defaults back for deploys and the Resources tab.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { appMemoryAutotune, apps } from "@/lib/db/schema";
import { addDailyPeak } from "@/lib/autotune/decide";
import { logger } from "@/lib/logger";
import { readSeries } from "@/lib/metrics/resource-samples";
import { appResourceScope, seriesInScope } from "@/lib/metrics/resource-scope";
import type { QosTier } from "./defaults";
import { tierMemoryMb } from "./host";
import { BUCKET_MS, dayUsage, learnedDefault, previousUtcDay, type LearnedDefault } from "./learned";

const log = logger.child("resources");

/** Apps a learned default could cover: no limit of their own, not Vardo's, not a stack parent. */
async function learnableApps() {
  const parents = alias(apps, "learned_parent");
  return db
    .select({
      id: apps.id,
      name: apps.name,
      organizationId: apps.organizationId,
      parentAppId: apps.parentAppId,
      composeService: apps.composeService,
      parentName: parents.name,
    })
    .from(apps)
    .leftJoin(parents, eq(parents.id, apps.parentAppId))
    .where(
      and(
        isNull(apps.memoryLimit),
        eq(apps.isSystemManaged, false),
        sql`not exists (select 1 from ${apps} c where c.parent_app_id = ${apps.id})`,
      ),
    );
}

/** Records yesterday's p99 for every learnable app. Safe to repeat for the same day. Returns apps recorded. */
export async function recordDailyUsage(now: Date = new Date()): Promise<number> {
  const { day, from, to } = previousUtcDay(now.getTime());
  const rows = await learnableApps();
  if (rows.length === 0) return 0;

  const [series, topLevel, states] = await Promise.all([
    readSeries(["memory"], from, to - 1, BUCKET_MS),
    db.select({ name: apps.name }).from(apps).where(isNull(apps.parentAppId)),
    db.select().from(appMemoryAutotune).where(inArray(appMemoryAutotune.appId, rows.map((r) => r.id))),
  ]);
  const known = new Set(topLevel.map((a) => a.name));
  const memory = series.get("memory");
  const byApp = new Map(states.map((s) => [s.appId, s]));

  let recorded = 0;
  for (const app of rows) {
    const scope = appResourceScope({ ...app, parentApp: app.parentName ? { name: app.parentName } : null }, known);
    const usage = dayUsage(seriesInScope(memory, scope).map((s) => s.points));
    if (!usage) continue;
    try {
      const dailyPeaks = addDailyPeak(byApp.get(app.id)?.dailyPeaks ?? [], day, usage.peak, usage.p99);
      await db
        .insert(appMemoryAutotune)
        .values({ appId: app.id, organizationId: app.organizationId, dailyPeaks, updatedAt: now })
        .onConflictDoUpdate({ target: appMemoryAutotune.appId, set: { dailyPeaks, updatedAt: now } });
      recorded++;
    } catch (err) {
      log.warn(`Couldn't record memory use for ${app.id}:`, (err as Error).message);
    }
  }
  return recorded;
}

/** Learned defaults by app id for apps that have one. Never throws. */
export async function learnedDefaults(subjects: { id: string; tier: QosTier }[], now = Date.now()): Promise<Map<string, LearnedDefault>> {
  const out = new Map<string, LearnedDefault>();
  if (subjects.length === 0) return out;
  try {
    const rows = await db
      .select({ appId: appMemoryAutotune.appId, dailyPeaks: appMemoryAutotune.dailyPeaks })
      .from(appMemoryAutotune)
      .where(inArray(appMemoryAutotune.appId, subjects.map((s) => s.id)));
    const peaks = new Map(rows.map((r) => [r.appId, r.dailyPeaks]));
    for (const s of subjects) {
      const learned = learnedDefault(peaks.get(s.id) ?? [], tierMemoryMb(s.tier), now);
      if (learned) out.set(s.id, learned);
    }
  } catch (err) {
    log.warn("Couldn't read learned memory defaults; using tier defaults:", (err as Error).message);
  }
  return out;
}
