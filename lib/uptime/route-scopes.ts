// How an API request becomes an uptime scope: the org's membership for org routes, app admin for admin routes.

import { requireAdminAuth } from "@/lib/auth/admin";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import type { ResolveScope } from "./route-handlers";

export const orgScope: ResolveScope = async (_request, params, access) => {
  const org = await verifyOrgAccess(params.orgId, access === "view" ? "uptime.view" : "uptime.manage");
  return org ? { kind: "org", orgId: params.orgId } : null;
};

export const instanceScope: ResolveScope = async (request) => {
  await requireAdminAuth(request);
  return { kind: "instance" };
};
