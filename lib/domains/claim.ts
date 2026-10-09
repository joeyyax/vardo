// A verified host evicts other orgs' unverified rows for it (#897).

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, organizations } from "@/lib/db/schema";
import { emit } from "@/lib/notifications/dispatch";
import { loadInstanceHosts, loadVerifiedZones } from "./context";
import { isRoutable } from "./ownership";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

/** What the org proved: one host, or a zone and every host under it. */
export type Claim = { orgId: string; host: string; zone: boolean };

export type Evicted = { id: string; domain: string; appId: string; appName: string; orgId: string };

export type HostHold = "free" | "claimable" | "taken";

type Held = Evicted & { verifiedAt: Date | null; trusted: boolean; isSystemManaged: boolean };

async function otherOrgRows(exec: Exec, claim: Claim): Promise<Held[]> {
  const host = claim.host.toLowerCase();
  const lower = sql<string>`lower(${domains.domain})`;
  const match = claim.zone ? or(eq(lower, host), sql`${lower} like ${`%.${host}`}`) : eq(lower, host);
  return exec
    .select({
      id: domains.id,
      domain: domains.domain,
      appId: apps.id,
      appName: apps.name,
      orgId: apps.organizationId,
      verifiedAt: domains.verifiedAt,
      trusted: organizations.trusted,
      isSystemManaged: organizations.isSystemManaged,
    })
    .from(domains)
    .innerJoin(apps, eq(domains.appId, apps.id))
    .innerJoin(organizations, eq(apps.organizationId, organizations.id))
    .where(and(match, ne(apps.organizationId, claim.orgId)));
}

/** Rows that don't route for their own org: unverified, untrusted and outside any zone it verified. */
async function evictable(rows: Held[]): Promise<Held[]> {
  if (rows.length === 0) return [];
  const inst = await loadInstanceHosts();
  const zones = new Map<string, string[]>();
  const out: Held[] = [];
  for (const r of rows) {
    if (r.verifiedAt || r.isSystemManaged) continue;
    if (!zones.has(r.orgId)) zones.set(r.orgId, await loadVerifiedZones(r.orgId));
    if (!isRoutable({ domain: r.domain, verifiedAt: null }, inst, { trusted: r.trusted }, zones.get(r.orgId)!)) out.push(r);
  }
  return out;
}

/** Whether other orgs hold the host, and whether proving it would evict them all. */
export async function hostHoldByOtherOrg(host: string, orgId: string): Promise<HostHold> {
  const rows = await otherOrgRows(db, { orgId, host, zone: false });
  if (rows.length === 0) return "free";
  return (await evictable(rows)).length === rows.length ? "claimable" : "taken";
}

/** Deletes the evictable rows and flags their apps to redeploy. Run inside the transaction that records the proof. */
export async function evictSquatters(tx: Tx, claim: Claim): Promise<Evicted[]> {
  const rows = await evictable(await otherOrgRows(tx, claim));
  if (rows.length === 0) return [];
  await tx.delete(domains).where(and(inArray(domains.id, rows.map((r) => r.id)), isNull(domains.verifiedAt)));
  await tx
    .update(apps)
    .set({ needsRedeploy: true, updatedAt: new Date() })
    .where(inArray(apps.id, [...new Set(rows.map((r) => r.appId))]));
  return rows.map(({ id, domain, appId, appName, orgId }) => ({ id, domain, appId, appName, orgId }));
}

/** Tells each org which of its domains were removed. Call after the transaction commits. */
export function notifyEvicted(evicted: Evicted[]): void {
  const byOrg = new Map<string, Evicted[]>();
  for (const e of evicted) byOrg.set(e.orgId, [...(byOrg.get(e.orgId) ?? []), e]);
  for (const [orgId, rows] of byOrg) {
    const hosts = [...new Set(rows.map((r) => r.domain))];
    const list = rows.map((r) => `${r.domain} (${r.appName})`).join(", ");
    emit(orgId, {
      type: "security.domain-claimed",
      title: hosts.length === 1 ? `${hosts[0]} was claimed by its owner` : `${hosts.length} domains were claimed by their owner`,
      message: `Another organization proved it owns ${hosts.join(", ")}. Removed the unverified ${rows.length === 1 ? "domain" : "domains"}: ${list}.`,
      domains: hosts,
      appIds: [...new Set(rows.map((r) => r.appId))],
    });
  }
}

/** Evicts the claim's squatters and runs `write` in one transaction, then notifies them. Without a claim, runs `write` alone. */
export async function withClaim<T>(claim: Claim | null, write: (exec: Exec) => Promise<T>): Promise<T> {
  if (!claim) return write(db);
  const { result, evicted } = await db.transaction(async (tx) => {
    const evicted = await evictSquatters(tx, claim);
    return { result: await write(tx), evicted };
  });
  notifyEvicted(evicted);
  return result;
}
