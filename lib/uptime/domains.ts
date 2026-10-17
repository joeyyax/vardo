// Domain reachability, read from the automatic monitors of app domains. Local-vantage results only, as domain monitoring once was.

import { and, desc, eq, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, environments, uptimeMonitors, uptimeResults } from "@/lib/db/schema";
import { ERROR_TEXT } from "./format";
import { load, summarizeRow } from "./service";
import { LOCAL_VANTAGE_ID } from "./vantage";
import type { DomainCheck, DomainCheckHistory, DomainReachability, ErrorKind, RecentDomainCheck } from "./types";

/** Results that say nothing about the domain. */
const UNKNOWN_ERRORS = ["private-address", "blocked"];

const FIVE_MIN_MS = 5 * 60_000;

/** Reachability of these domains, for the domains that have an automatic monitor turned on. */
export async function domainReachability(orgId: string, domainIds: string[], now = Date.now()): Promise<DomainReachability[]> {
  if (domainIds.length === 0) return [];
  const rows = await db
    .select()
    .from(uptimeMonitors)
    .where(and(eq(uptimeMonitors.organizationId, orgId), eq(uptimeMonitors.enabled, true), inArray(uptimeMonitors.domainId, domainIds)));
  if (rows.length === 0) return [];
  const ctx = await load(rows, now);
  return rows.map((row) => {
    const summary = summarizeRow(row, ctx, now);
    const local = (ctx.recent.get(row.id) ?? []).filter((r) => r.vantageId === LOCAL_VANTAGE_ID && !UNKNOWN_ERRORS.includes(r.error ?? "")).sort((a, b) => b.at - a.at)[0];
    return {
      domainId: row.domainId!,
      monitorId: row.id,
      reachable: local ? local.ok : null,
      confirmedUnreachable: summary.state === "down",
      lastCheckedAt: local?.at ?? null,
      statusCode: local?.status ?? null,
      latencyMs: local?.latencyMs ?? null,
      error: local && !local.ok ? ERROR_TEXT[local.error ?? "unknown"] : null,
    };
  });
}

/** Production domain checks in [from, to), for the hourly rollup. */
export async function domainChecks(fromMs: number, toMs: number): Promise<DomainCheck[]> {
  const rows = await db
    .select({ appId: domains.appId, at: uptimeResults.at, ok: uptimeResults.ok, latencyMs: uptimeResults.latencyMs })
    .from(uptimeResults)
    .innerJoin(uptimeMonitors, eq(uptimeMonitors.id, uptimeResults.monitorId))
    .innerJoin(domains, eq(domains.id, uptimeMonitors.domainId))
    // Older releases stored a non-default environment's hostname as a domain row; those aren't production.
    .leftJoin(environments, and(eq(environments.appId, domains.appId), eq(environments.domain, domains.domain), sql`${environments.isDefault} is not true`))
    .where(
      and(
        eq(uptimeResults.vantageId, LOCAL_VANTAGE_ID),
        gte(uptimeResults.at, new Date(fromMs)),
        lt(uptimeResults.at, new Date(toMs)),
        notInArray(sql`coalesce(${uptimeResults.error}, '')`, UNKNOWN_ERRORS),
        isNull(environments.id),
      ),
    );
  return rows.map((r) => ({ appId: r.appId, at: r.at.getTime(), reachable: r.ok, responseTimeMs: r.latencyMs }));
}

/** Past outcomes of these apps' domains, counted in five-minute slots so a faster check doesn't read as more failures. */
export async function domainCheckHistory(appIds: string[], baselineFromMs: number, sinceMs: number): Promise<DomainCheckHistory> {
  if (appIds.length === 0) return { prior: [], failures: [] };
  const slot = sql<number>`floor(extract(epoch from ${uptimeResults.at}) / ${FIVE_MIN_MS / 1000})`;
  const scope = and(
    inArray(domains.appId, appIds),
    eq(uptimeResults.vantageId, LOCAL_VANTAGE_ID),
    gte(uptimeResults.at, new Date(baselineFromMs)),
    notInArray(sql`coalesce(${uptimeResults.error}, '')`, UNKNOWN_ERRORS),
  );
  const prior = await db
    .select({ domainId: uptimeMonitors.domainId, reachable: uptimeResults.ok, n: sql<number>`count(distinct ${slot})::int` })
    .from(uptimeResults)
    .innerJoin(uptimeMonitors, eq(uptimeMonitors.id, uptimeResults.monitorId))
    .innerJoin(domains, eq(domains.id, uptimeMonitors.domainId))
    .where(and(scope, lt(uptimeResults.at, new Date(sinceMs))))
    .groupBy(uptimeMonitors.domainId, uptimeResults.ok);

  const failures = await db
    .select({
      domainId: uptimeMonitors.domainId,
      domain: domains.domain,
      appId: domains.appId,
      at: sql<Date>`min(${uptimeResults.at})`,
    })
    .from(uptimeResults)
    .innerJoin(uptimeMonitors, eq(uptimeMonitors.id, uptimeResults.monitorId))
    .innerJoin(domains, eq(domains.id, uptimeMonitors.domainId))
    .where(and(scope, gte(uptimeResults.at, new Date(sinceMs)), eq(uptimeResults.ok, false)))
    .groupBy(uptimeMonitors.domainId, domains.domain, domains.appId, slot);

  return {
    prior: prior.map((r) => ({ domainId: r.domainId!, reachable: r.reachable, n: r.n })),
    failures: failures.map((r) => ({ domainId: r.domainId!, domain: r.domain, appId: r.appId, at: new Date(r.at).getTime() })),
  };
}

/** The newest `perDomain` checks of each domain in the org, newest first. */
export async function recentDomainChecks(orgId: string, domainIds: string[], perDomain: number): Promise<RecentDomainCheck[]> {
  if (domainIds.length === 0) return [];
  const ranked = db
    .select({
      id: uptimeResults.id,
      domainId: uptimeMonitors.domainId,
      ok: uptimeResults.ok,
      status: uptimeResults.status,
      latencyMs: uptimeResults.latencyMs,
      error: uptimeResults.error,
      at: uptimeResults.at,
      rn: sql<number>`row_number() over (partition by ${uptimeMonitors.domainId} order by ${uptimeResults.at} desc)`.as("rn"),
    })
    .from(uptimeResults)
    .innerJoin(uptimeMonitors, eq(uptimeMonitors.id, uptimeResults.monitorId))
    .where(
      and(
        eq(uptimeMonitors.organizationId, orgId),
        inArray(uptimeMonitors.domainId, domainIds),
        eq(uptimeResults.vantageId, LOCAL_VANTAGE_ID),
        notInArray(sql`coalesce(${uptimeResults.error}, '')`, UNKNOWN_ERRORS),
      ),
    )
    .as("ranked");
  const rows = await db.select().from(ranked).where(sql`${ranked.rn} <= ${perDomain}`).orderBy(desc(ranked.at));
  return rows.map((r) => ({
    id: String(r.id),
    domainId: r.domainId!,
    reachable: r.ok,
    statusCode: r.status,
    responseTimeMs: r.latencyMs,
    error: r.ok || !r.error ? null : (ERROR_TEXT[r.error as ErrorKind] ?? ERROR_TEXT.unknown),
    checkedAt: new Date(r.at).toISOString(),
  }));
}
