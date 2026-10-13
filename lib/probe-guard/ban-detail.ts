// What each banned address probed, read from its recorded events.

import { and, gt, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { probeEvents } from "@/lib/db/schema";
import { pathLabeler } from "./labels";
import { guardBlocks } from "./sync";
import type { BanDetail, PathCount, ProbeCount } from "./summary";

export const DETAIL_PATHS = 10;
const SLACK_MS = 60_000;

/** Value counts, most frequent first, ties alphabetical. */
function tally(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

type LabelFor = (path: string, appId: string | null) => string;

/** Category and path counts for probed paths. */
export function summarizeProbePaths(
  probes: readonly { path: string; appId: string | null }[],
  labelFor: LabelFor = pathLabeler(),
  maxPaths = DETAIL_PATHS,
): { categories: ProbeCount[]; paths: PathCount[] } {
  return {
    categories: tally(probes.map((p) => labelFor(p.path, p.appId))).map(([label, count]) => ({ label, count })),
    paths: tally(probes.map((p) => p.path)).slice(0, maxPaths).map(([path, count]) => ({ path, count })),
  };
}

export type DetailEvent = { ip: string; kind: string; path: string | null; appId: string | null; createdAt: Date };

/** One ban's detail from the events its address left in the window before it. */
export function banDetailFrom(
  ban: { ip: string; createdAt: Date },
  events: readonly DetailEvent[],
  windowMs: number,
  labelFor: LabelFor = pathLabeler(),
): BanDetail {
  const from = ban.createdAt.getTime() - windowMs - SLACK_MS;
  const to = ban.createdAt.getTime() + SLACK_MS;
  const mine = events.filter((e) => e.ip === ban.ip && e.path && e.createdAt.getTime() >= from && e.createdAt.getTime() <= to);
  const probes = mine.filter((e) => e.kind === "probe").map((e) => ({ path: e.path!, appId: e.appId }));
  const trap = mine.filter((e) => e.kind === "trap").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return { ...summarizeProbePaths(probes, labelFor), trapPath: trap?.path ?? null };
}

/** Details for a set of bans, keyed by ban id. */
export async function banDetails(
  bans: readonly { id: string; ip: string; createdAt: Date }[],
  windowMs: number,
): Promise<Map<string, BanDetail>> {
  const out = new Map<string, BanDetail>();
  if (bans.length === 0) return out;
  const since = new Date(Math.min(...bans.map((b) => b.createdAt.getTime())) - windowMs - SLACK_MS);
  const events = await db
    .select({ ip: probeEvents.ip, kind: probeEvents.kind, path: probeEvents.path, appId: probeEvents.appId, createdAt: probeEvents.createdAt })
    .from(probeEvents)
    .where(and(
      gt(probeEvents.createdAt, since),
      inArray(probeEvents.kind, ["probe", "trap"]),
      inArray(probeEvents.ip, [...new Set(bans.map((b) => b.ip))]),
    ));
  const blocks = await guardBlocks(events.flatMap((e) => (e.appId ? [e.appId] : [])));
  const labelFor = pathLabeler(blocks);
  for (const ban of bans) out.set(ban.id, banDetailFrom(ban, events, windowMs, labelFor));
  return out;
}
