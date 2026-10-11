// Builds the guard file from the database and writes it. Every writer renders the whole file from current rows.

import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, probeBans, probeCanaries } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { MAX_RENDERED_BANS, MAX_RENDERED_MARKERS, writeGuardFile, type GuardApp, type GuardState } from "./traefik-file";
import { detectWordPress, isWordPress, normalizeAppProbeGuard } from "./settings";
import { getProbeGuardSettings, guardKey } from "./instance";

const log = logger.child("probe-guard");

const MARKER_TTL_MS = 30 * 24 * 3_600_000;

/** Guarded apps with their hosts. Children's domains count toward their parent. */
export async function loadGuardApps(): Promise<GuardApp[]> {
  const rows = await db
    .select({
      id: apps.id,
      parentAppId: apps.parentAppId,
      probeGuard: apps.probeGuard,
      imageName: apps.imageName,
      templateName: apps.templateName,
      composeContent: apps.composeContent,
    })
    .from(apps);
  const top = rows.filter((r) => !r.parentAppId);
  const parentOf = new Map(rows.map((r) => [r.id, r.parentAppId ?? r.id]));
  const childImages = new Map<string, (string | null)[]>();
  for (const r of rows) if (r.parentAppId) childImages.set(r.parentAppId, [...(childImages.get(r.parentAppId) ?? []), r.imageName]);

  const hostRows = await db
    .select({ appId: domains.appId, domain: domains.domain })
    .from(domains)
    .where(isNull(domains.pathPrefix));
  const hosts = new Map<string, string[]>();
  for (const h of hostRows) {
    const owner = parentOf.get(h.appId);
    if (owner) hosts.set(owner, [...(hosts.get(owner) ?? []), h.domain]);
  }

  return top.flatMap((app) => {
    const guard = normalizeAppProbeGuard(app.probeGuard);
    if (!guard.enabled) return [];
    const detected = detectWordPress({ ...app, childImages: childImages.get(app.id) });
    return [{
      id: app.id,
      hosts: hosts.get(app.id) ?? [],
      exceptions: guard.exceptions,
      wordpress: isWordPress(guard, detected),
      robotsTxt: guard.robotsTxt,
    }];
  });
}

export async function activeBannedIps(now = new Date()): Promise<string[]> {
  const rows = await db
    .select({ ip: probeBans.ip })
    .from(probeBans)
    .where(and(isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now)))
    .orderBy(desc(probeBans.expiresAt))
    .limit(MAX_RENDERED_BANS);
  return [...new Set(rows.map((r) => r.ip))];
}

export async function activeMarkers(now = new Date()): Promise<string[]> {
  const rows = await db
    .select({ marker: probeCanaries.marker })
    .from(probeCanaries)
    .where(gt(probeCanaries.lastFetchedAt, new Date(now.getTime() - MARKER_TTL_MS)))
    .orderBy(desc(probeCanaries.lastFetchedAt))
    .limit(MAX_RENDERED_MARKERS);
  return rows.map((r) => r.marker);
}

export async function loadGuardState(): Promise<GuardState | null> {
  const key = guardKey();
  if (!key) return null;
  const [settings, guardApps, bannedIps, markers] = await Promise.all([
    getProbeGuardSettings(),
    loadGuardApps(),
    activeBannedIps(),
    activeMarkers(),
  ]);
  return {
    key,
    apps: guardApps,
    bannedIps,
    trapPaths: settings.traps.enabled ? settings.traps.paths : [],
    markers,
    responderUrl: process.env.VARDO_PROBE_GUARD_URL || null,
  };
}

let chain: Promise<unknown> = Promise.resolve();

/** Rewrites the guard file from current rows. Calls in one process run in order. */
export function syncGuardFile(): Promise<"written" | "unchanged" | "skipped"> {
  const run = chain.then(async () => {
    const state = await loadGuardState();
    if (!state) return "skipped" as const;
    const outcome = await writeGuardFile(state);
    if (outcome === "written") log.info(`Probe guard file written: ${state.apps.length} apps, ${state.bannedIps.length} bans`);
    return outcome;
  });
  chain = run.catch(() => {});
  return run;
}

/** Fire-and-forget rewrite that logs instead of throwing. */
export function syncGuardFileSoon(): void {
  syncGuardFile().catch((err) => log.warn("Couldn't write the probe guard file:", err));
}

/** The guarded app a hostname belongs to. */
export async function appForHost(host: string): Promise<{ id: string; organizationId: string } | null> {
  const h = host.split(":")[0].toLowerCase();
  const rows = await db
    .select({ appId: domains.appId })
    .from(domains)
    .where(and(isNull(domains.pathPrefix), eq(domains.domain, h)))
    .limit(1);
  if (!rows[0]) return null;
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, rows[0].appId),
    columns: { id: true, organizationId: true, parentAppId: true },
  });
  if (!app) return null;
  return { id: app.parentAppId ?? app.id, organizationId: app.organizationId };
}
