// Runs the TXT challenge for one row and records the outcome (#891).

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, organizations, orgDomains } from "@/lib/db/schema";
import { evictSquatters, notifyEvicted, type Claim, type Evicted } from "./claim";
import {
  challengeName,
  checkChallenge,
  newChallengeToken,
  type ChallengeResult,
  type TxtResolver,
} from "./ownership";

export type Target =
  | { kind: "app-domain"; id: string }
  | { kind: "org-domain"; id: string }
  | { kind: "org-base"; id: string };

export type CheckOutcome = {
  host: string;
  recordName: string;
  recordValue: string;
  result: ChallengeResult;
  verifiedAt: Date | null;
};

type Loaded = { host: string; token: string | null; verifiedAt: Date | null; orgId: string };
type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function load(t: Target): Promise<Loaded | null> {
  if (t.kind === "app-domain") {
    const [r] = await db
      .select({ domain: domains.domain, token: domains.verificationToken, verifiedAt: domains.verifiedAt, orgId: apps.organizationId })
      .from(domains)
      .innerJoin(apps, eq(domains.appId, apps.id))
      .where(eq(domains.id, t.id));
    return r ? { host: r.domain, token: r.token, verifiedAt: r.verifiedAt, orgId: r.orgId } : null;
  }
  if (t.kind === "org-domain") {
    const [r] = await db.select().from(orgDomains).where(eq(orgDomains.id, t.id));
    return r ? { host: r.domain, token: r.verificationToken, verifiedAt: r.verifiedAt, orgId: r.organizationId } : null;
  }
  const [r] = await db.select().from(organizations).where(eq(organizations.id, t.id));
  return r?.baseDomain ? { host: r.baseDomain, token: r.baseDomainToken, verifiedAt: r.baseDomainVerifiedAt, orgId: r.id } : null;
}

async function save(t: Target, patch: { token?: string; verifiedAt?: Date | null }, exec: Exec = db): Promise<void> {
  const verified = patch.verifiedAt !== undefined ? { verifiedAt: patch.verifiedAt } : {};
  if (t.kind === "app-domain") {
    await exec.update(domains).set({
      ...(patch.token ? { verificationToken: patch.token } : {}),
      ...verified,
    }).where(eq(domains.id, t.id));
  } else if (t.kind === "org-domain") {
    await exec.update(orgDomains).set({
      ...(patch.token ? { verificationToken: patch.token } : {}),
      ...verified,
      ...(patch.verifiedAt !== undefined ? { verified: patch.verifiedAt !== null } : {}),
    }).where(eq(orgDomains.id, t.id));
  } else {
    await exec.update(organizations).set({
      ...(patch.token ? { baseDomainToken: patch.token } : {}),
      ...(patch.verifiedAt !== undefined ? { baseDomainVerifiedAt: patch.verifiedAt } : {}),
    }).where(eq(organizations.id, t.id));
  }
}

/**
 * Checks the row's challenge record. A confirmed record verifies it and evicts other orgs' unverified rows it covers.
 * An absent record unverifies it only when `revoke` is set; a failed lookup never changes anything.
 */
export async function runCheck(
  t: Target,
  opts: { revoke?: boolean; resolveTxt?: TxtResolver } = {},
): Promise<CheckOutcome | null> {
  const row = await load(t);
  if (!row) return null;

  let token = row.token;
  if (!token) {
    token = newChallengeToken();
    await save(t, { token });
  }

  const result = await checkChallenge(row.host, token, opts.resolveTxt);
  let verifiedAt = row.verifiedAt;
  if (result.status === "verified") {
    const claim: Claim = { orgId: row.orgId, host: row.host, zone: t.kind !== "app-domain" };
    const firstProof = !verifiedAt;
    verifiedAt ??= new Date();
    const at = verifiedAt;
    const evicted: Evicted[] = await db.transaction(async (tx) => {
      if (firstProof) {
        await save(t, { verifiedAt: at }, tx);
        if (t.kind === "app-domain") await flagRedeploy(t.id, tx);
      }
      return evictSquatters(tx, claim);
    });
    notifyEvicted(evicted);
  } else if (result.status === "missing" && opts.revoke && verifiedAt) {
    verifiedAt = null;
    await save(t, { verifiedAt: null });
    if (t.kind === "app-domain") await flagRedeploy(t.id);
  }
  return { host: row.host, recordName: challengeName(row.host), recordValue: token, result, verifiedAt };
}

async function flagRedeploy(domainId: string, exec: Exec = db): Promise<void> {
  const [d] = await exec.select({ appId: domains.appId }).from(domains).where(eq(domains.id, domainId));
  if (d) await exec.update(apps).set({ needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, d.appId));
}
