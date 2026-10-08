// Server side of #891: loads what the ownership rules in ./ownership.ts need.

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, orgDomains } from "@/lib/db/schema";
import { getInstanceConfig } from "@/lib/system-settings";
import { DEFAULT_BASE_DOMAIN } from "@/lib/domain-monitoring/auto-domain";
import {
  consoleHostsFrom,
  coveredByZone,
  needsChallenge,
  newChallengeToken,
  refusedHost,
  type InstanceHosts,
} from "./ownership";

export async function loadInstanceHosts(): Promise<InstanceHosts> {
  const instance = await getInstanceConfig();
  const base = (instance.baseDomain || DEFAULT_BASE_DOMAIN).toLowerCase() || null;
  return { base, console: consoleHostsFrom(instance.domain) };
}

/** Zones the org proved it controls: verified org domains and a verified base domain. */
export async function loadVerifiedZones(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ domain: orgDomains.domain })
    .from(orgDomains)
    .where(and(
      eq(orgDomains.organizationId, orgId),
      eq(orgDomains.isDefault, false),
      isNotNull(orgDomains.verifiedAt),
    ));
  const [org] = await db
    .select({ baseDomain: organizations.baseDomain, verifiedAt: organizations.baseDomainVerifiedAt })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const zones = rows.map((r) => r.domain.toLowerCase());
  if (org?.baseDomain && org.verifiedAt) zones.push(org.baseDomain.toLowerCase());
  return zones;
}


/** What a new or renamed domain row needs: the refusal, or the proof fields to store. */
export async function proofForNewDomain(
  host: string,
  orgId: string,
): Promise<{ refusal: string } | { verificationToken: string; verifiedAt: Date | null }> {
  const inst = await loadInstanceHosts();
  const refusal = refusedHost(host, inst);
  if (refusal) return { refusal };
  const [org] = await db.select({ trusted: organizations.trusted }).from(organizations).where(eq(organizations.id, orgId));
  const covered = needsChallenge(host, inst, { trusted: org?.trusted ?? false })
    && coveredByZone(host, await loadVerifiedZones(orgId));
  return { verificationToken: newChallengeToken(), verifiedAt: covered ? new Date() : null };
}
