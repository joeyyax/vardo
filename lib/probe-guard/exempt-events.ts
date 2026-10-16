// Probe events from addresses bans skip, left over from before they stopped being recorded.

import { and, count, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { probeEvents } from "@/lib/db/schema";
import { exemptCheck } from "./client-lists";

export type ExemptEvents = { ips: string[]; count: number };

/** Exempt addresses with recorded probe events since a time, and how many events they hold. */
export async function exemptProbeEvents(since: Date, appId?: string): Promise<ExemptEvents> {
  const filters = [eq(probeEvents.kind, "probe"), gte(probeEvents.createdAt, since)];
  if (appId) filters.push(eq(probeEvents.appId, appId));
  const [rows, isExempt] = await Promise.all([
    db.select({ ip: probeEvents.ip, n: count() }).from(probeEvents).where(and(...filters)).groupBy(probeEvents.ip),
    exemptCheck(),
  ]);
  const own = rows.filter((r) => isExempt(r.ip));
  return { ips: own.map((r) => r.ip), count: own.reduce((sum, r) => sum + r.n, 0) };
}
