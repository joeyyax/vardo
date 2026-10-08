// Deploy gate: every hostname a Traefik label claims must belong to the deploying org.

import { and, eq, inArray, isNull, like, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, environments, organizations, orgDomains } from "@/lib/db/schema";
import { getInstanceConfig } from "@/lib/system-settings";
import { DEFAULT_BASE_DOMAIN } from "@/lib/domain-monitoring/auto-domain";
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
  /** Hosts this deploy routes from its own domain rows. */
  deployHosts: string[];
};

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export type OwnershipRows = {
  instanceBase: string | null;
  /** The console's own hostnames. */
  consoleHosts: (string | null | undefined)[];
  /** Domain and environment rows matching the claimed names, with their org. */
  hostRows: { domain: string | null; orgId: string }[];
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
    if (r.domain) (r.orgId === orgId ? ownedHosts : foreignHosts).add(r.domain.toLowerCase());
  }
  for (const h of rows.consoleHosts) if (h) foreignHosts.add(h.toLowerCase());

  // Unverified org domains and the org's base domain are owner-set, so only trusted orgs get them.
  const ownedZones = rows.orgDomainRows.filter((r) => trusted || r.verified).map((r) => r.domain.toLowerCase());
  if (trusted && input.orgBaseDomain) ownedZones.push(input.orgBaseDomain.toLowerCase());

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

  const hostRows: OwnershipRows["hostRows"] = [];
  if (claimed.hosts.length > 0 || claimed.zones.length > 0) {
    hostRows.push(
      ...(await db
        .select({ domain: domains.domain, orgId: apps.organizationId })
        .from(domains)
        .innerJoin(apps, eq(domains.appId, apps.id))
        .where(matchHost(domains.domain))),
      ...(await db
        .select({ domain: environments.domain, orgId: apps.organizationId })
        .from(environments)
        .innerJoin(apps, eq(environments.appId, apps.id))
        .where(matchHost(environments.domain))),
    );
  }

  const orgDomainRows = await db
    .select({ domain: orgDomains.domain, verified: orgDomains.verified })
    .from(orgDomains)
    .where(and(
      eq(orgDomains.organizationId, input.organizationId),
      eq(orgDomains.enabled, true),
      eq(orgDomains.isDefault, false),
    ));

  const candidates = [...new Set(claimed.hosts.flatMap((h) => nameCandidates(h, instanceBase)))];
  const appNames = candidates.length > 0
    ? await db
        .select({ name: apps.name, orgId: apps.organizationId })
        .from(apps)
        .where(and(inArray(apps.name, candidates), isNull(apps.parentAppId)))
    : [];

  return buildHostOwnership(input, {
    instanceBase,
    consoleHosts: [instance.domain, process.env.VARDO_DOMAIN, hostOf(process.env.NEXT_PUBLIC_BETTER_AUTH_URL)],
    hostRows,
    orgDomainRows,
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
