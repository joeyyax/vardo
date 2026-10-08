// Deploy gate: every hostname a Traefik label claims must belong to the deploying org.

import { and, eq, inArray, isNull, like, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, environments, organizations, orgDomains } from "@/lib/db/schema";
import { getInstanceConfig } from "@/lib/system-settings";
import { DEFAULT_BASE_DOMAIN } from "@/lib/domain-monitoring/auto-domain";
import { consoleHostsFrom, coveredByZone, isUnder } from "@/lib/domains/ownership";
import type { ComposeFile } from "./compose-types";
import type { DeployContext } from "./deploy-context";
import { DeployBlockedError } from "./errors";
import {
  claimedNames,
  collectLabelRules,
  judgeLabelRules,
  nameCandidates,
  refusalMessage,
  type HostOwnership,
  type LabelRule,
  type LabelVerdict,
} from "./compose-hosts";

export type OwnershipInput = {
  organizationId: string;
  trusted: boolean;
  orgBaseDomain: string | null;
  /** The org proved it controls its base domain (#891). */
  orgBaseVerified?: boolean;
  /** Hosts this deploy routes from its own domain rows. */
  deployHosts: string[];
};

export type OwnershipRows = {
  instanceBase: string | null;
  /** The console's own hostnames. */
  consoleHosts: (string | null | undefined)[];
  /** Domain and environment rows matching the claimed names, with their org. A row counts once its org may route it: trusted, under the instance base or verified. */
  hostRows: { domain: string | null; orgId: string; counts: boolean }[];
  /** The org's enabled, non-default org domains. */
  orgDomainRows: { domain: string; verified: boolean | null }[];
  /** Top-level apps whose name prefixes a claimed host. */
  appNames: { name: string; orgId: string }[];
};

/** What the org may route, from rows already loaded. */
export function buildHostOwnership(input: OwnershipInput, rows: OwnershipRows): HostOwnership {
  const { organizationId: orgId, trusted } = input;
  const ownedHosts = new Set(input.deployHosts.map((h) => h.toLowerCase()));
  const foreignHosts = new Set<string>();
  for (const r of rows.hostRows) {
    if (r.domain && r.counts) (r.orgId === orgId ? ownedHosts : foreignHosts).add(r.domain.toLowerCase());
  }
  for (const h of rows.consoleHosts) if (h) foreignHosts.add(h.toLowerCase());

  // Unverified org domains and the org's base domain are owner-set, so only trusted orgs get them.
  const ownedZones = rows.orgDomainRows.filter((r) => trusted || r.verified).map((r) => r.domain.toLowerCase());
  if ((trusted || input.orgBaseVerified) && input.orgBaseDomain) ownedZones.push(input.orgBaseDomain.toLowerCase());

  const appNameOrgs = new Map(rows.appNames.map((r) => [r.name, r.orgId]));
  return { trusted, ownedHosts, ownedZones, foreignHosts, instanceBase: rows.instanceBase, appNameOrgs, orgId };
}

/** Loads what the org owns, limited to the names the rules claim. */
export async function loadHostOwnership(
  input: OwnershipInput,
  claimed: { hosts: string[]; zones: string[] },
): Promise<HostOwnership> {
  const instance = await getInstanceConfig();
  const instanceBase = (instance.baseDomain || DEFAULT_BASE_DOMAIN).toLowerCase() || null;

  const matchHost = (col: typeof domains.domain | typeof environments.domain): SQL | undefined => {
    const parts: (SQL | undefined)[] = [];
    if (claimed.hosts.length > 0) parts.push(inArray(col, claimed.hosts));
    for (const z of claimed.zones) parts.push(eq(col, z), like(col, `%.${z}`));
    return parts.length > 0 ? or(...parts) : undefined;
  };

  const [orgRow] = await db
    .select({ baseDomain: organizations.baseDomain, baseVerifiedAt: organizations.baseDomainVerifiedAt })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId));

  const orgDomainRows = await db
    .select({ domain: orgDomains.domain, verifiedAt: orgDomains.verifiedAt })
    .from(orgDomains)
    .where(and(
      eq(orgDomains.organizationId, input.organizationId),
      eq(orgDomains.enabled, true),
      eq(orgDomains.isDefault, false),
    ));
  const myZones = orgDomainRows.filter((r) => r.verifiedAt).map((r) => r.domain.toLowerCase());
  if (orgRow?.baseDomain && orgRow.baseVerifiedAt) myZones.push(orgRow.baseDomain.toLowerCase());

  // A row counts once its org may route it. Unverified rows from untrusted orgs claim nothing.
  type Found = { domain: string | null; orgId: string; trusted: boolean; verifiedAt?: Date | null };
  const counts = (r: Found) =>
    !!r.domain &&
    (r.trusted ||
      !!r.verifiedAt ||
      (!!instanceBase && isUnder(r.domain, instanceBase)) ||
      (r.orgId === input.organizationId && coveredByZone(r.domain, myZones)));

  const hostRows: OwnershipRows["hostRows"] = [];
  if (claimed.hosts.length > 0 || claimed.zones.length > 0) {
    const found: Found[] = [
      ...(await db
        .select({ domain: domains.domain, orgId: apps.organizationId, trusted: organizations.trusted, verifiedAt: domains.verifiedAt })
        .from(domains)
        .innerJoin(apps, eq(domains.appId, apps.id))
        .innerJoin(organizations, eq(apps.organizationId, organizations.id))
        .where(matchHost(domains.domain))),
      ...(await db
        .select({ domain: environments.domain, orgId: apps.organizationId, trusted: organizations.trusted })
        .from(environments)
        .innerJoin(apps, eq(environments.appId, apps.id))
        .innerJoin(organizations, eq(apps.organizationId, organizations.id))
        .where(matchHost(environments.domain))),
    ];
    hostRows.push(...found.map((r) => ({ domain: r.domain, orgId: r.orgId, counts: counts(r) })));
  }

  const candidates = [...new Set(claimed.hosts.flatMap((h) => nameCandidates(h, instanceBase)))];
  const appNames = candidates.length > 0
    ? await db
        .select({ name: apps.name, orgId: apps.organizationId })
        .from(apps)
        .where(and(inArray(apps.name, candidates), isNull(apps.parentAppId)))
    : [];

  return buildHostOwnership({ ...input, orgBaseVerified: !!orgRow?.baseVerifiedAt }, {
    instanceBase,
    consoleHosts: consoleHostsFrom(instance.domain),
    hostRows,
    orgDomainRows: orgDomainRows.map((r) => ({ domain: r.domain, verified: !!r.verifiedAt })),
    appNames,
  });
}

/** Rules Vardo wrote from this deploy's own domains need no lookup. */
function onlyDeployHosts(rules: LabelRule[], deployHosts: Set<string>): boolean {
  const { hosts, zones } = claimedNames(rules);
  if (zones.length > 0 || hosts.some((h) => !deployHosts.has(h))) return false;
  const local: HostOwnership = {
    trusted: false,
    ownedHosts: deployHosts,
    ownedZones: [],
    foreignHosts: new Set(),
    instanceBase: null,
    appNameOrgs: new Map(),
    orgId: "",
  };
  return judgeLabelRules(rules, local).every((v) => v.verdict === "owned");
}

/** Refuses the deploy when a label claims a host the org doesn't own. Returns each label's verdict. */
export async function assertLabelHostsOwned(
  ctx: Pick<DeployContext, "organizationId" | "orgTrusted" | "org" | "envMap" | "log"> & {
    app: Pick<DeployContext["app"], "domains">;
  },
  compose: ComposeFile,
): Promise<LabelVerdict[]> {
  const rules = collectLabelRules(compose, ctx.envMap, process.env);
  if (rules.length === 0) return [];

  const deployHosts = new Set(ctx.app.domains.map((d) => d.domain.toLowerCase()));
  if (onlyDeployHosts(rules, deployHosts)) return [];

  const [org] = await db
    .select({ isSystemManaged: organizations.isSystemManaged })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId));
  // Vardo's own stack routes the console and its catch-all.
  if (org?.isSystemManaged) return [];

  const ownership = await loadHostOwnership(
    {
      organizationId: ctx.organizationId,
      trusted: ctx.orgTrusted,
      orgBaseDomain: ctx.org?.baseDomain ?? null,
      deployHosts: [...deployHosts],
    },
    claimedNames(rules),
  );
  const verdicts = judgeLabelRules(rules, ownership);

  for (const v of verdicts) {
    if (v.allowed && v.verdict === "uncertain") {
      ctx.log(`[deploy] Traefik: ${v.service} ${v.label} not checked; allowed for a trusted organization`);
    }
  }
  const refused = verdicts.filter((v) => !v.allowed);
  if (refused.length > 0) {
    throw new DeployBlockedError(
      `Couldn't deploy: a Traefik label claims a host this organization can't use.\n${refused.map(refusalMessage).join("\n")}`,
    );
  }
  return verdicts;
}
