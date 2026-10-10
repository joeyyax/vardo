// What the Metrics page shows for a viewer: the scope they asked for, if they may have it.

import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { isAppAdmin } from "@/lib/auth/admin";
import { getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { resolveMetricsScope } from "./core-services";

export type MetricsPageScope =
  | { kind: "none" }
  | { kind: "switch"; orgId: string }
  | {
      kind: "server" | "org";
      orgId: string;
      orgName: string;
      canServer: boolean;
      orgs: { id: string; name: string }[];
      apps: { id: string; name: string; displayName: string; status: string; parentAppId: string | null }[];
    };

/** Resolves `?scope=`. A non-current org of the viewer asks the page to switch to it first. */
export async function loadMetricsPageScope(param: string | undefined): Promise<MetricsPageScope> {
  const current = await getCurrentOrg();
  if (!current) return { kind: "none" };

  const [isAdmin, userOrgs] = await Promise.all([isAppAdmin(), getUserOrganizations()]);
  const currentOrg = current.organization;
  const orgs = userOrgs.map((o) => ({ id: o.id, name: o.name }));

  const scope = resolveMetricsScope({
    param,
    isAdmin,
    orgIds: [currentOrg.id, ...orgs.map((o) => o.id)],
    currentOrgId: currentOrg.id,
  });

  const base = { canServer: isAdmin, orgs };

  if (scope.kind === "server") {
    return { kind: "server", orgId: currentOrg.id, orgName: currentOrg.name, apps: [], ...base };
  }
  if (scope.orgId !== currentOrg.id) return { kind: "switch", orgId: scope.orgId };

  const appList = await db.query.apps.findMany({
    where: eq(apps.organizationId, currentOrg.id),
    orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
    columns: { id: true, name: true, displayName: true, status: true, parentAppId: true },
  });
  return { kind: "org", orgId: currentOrg.id, orgName: currentOrg.name, apps: appList, ...base };
}
