import { db } from "@/lib/db";
import { apps, memberships, organizations, projects } from "@/lib/db/schema";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { can, type Capability } from "@/lib/auth/permissions";
import { isInstanceAdminUser } from "@/lib/auth/system-org";
import type { McpAuthContext } from "./auth";

// Organization scoping for MCP tools, checked against live memberships on every request.
// Every tool's tenancy boundary runs through canAccessOrg and accessibleOrgIds; widening either widens all tools.

/** True when the token may act on `orgId` with `cap`: its scope intersected with the live role. */
export async function canAccessOrg(
  context: McpAuthContext,
  orgId: string,
  cap: Capability
): Promise<boolean> {
  if (!context.crossOrg && orgId !== context.organizationId) return false;

  const membership = await db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, context.userId),
      eq(memberships.organizationId, orgId)
    ),
    columns: { role: true },
    with: { organization: { columns: { isSystemManaged: true } } },
  });

  if (membership?.organization?.isSystemManaged && !(await isInstanceAdminUser(context.userId))) return false;
  return can({ role: membership?.role, scopes: context.scopes }, cap);
}

/** Every organization the token may act on with `cap`, resolved from live memberships. */
export async function accessibleOrgIds(
  context: McpAuthContext,
  cap: Capability
): Promise<string[]> {
  const all = await db.query.memberships.findMany({
    where: eq(memberships.userId, context.userId),
    columns: { organizationId: true, role: true },
    with: { organization: { columns: { isSystemManaged: true } } },
  });
  const rows =
    all.some((r) => r.organization?.isSystemManaged) && !(await isInstanceAdminUser(context.userId))
      ? all.filter((r) => !r.organization?.isSystemManaged)
      : all;

  const memberOrgIds = [
    ...new Set(rows.filter((r) => can({ role: r.role, scopes: context.scopes }, cap)).map((r) => r.organizationId)),
  ];

  return context.crossOrg
    ? memberOrgIds
    : memberOrgIds.filter((id) => id === context.organizationId);
}

/** Org to create a resource in. A caller-supplied `requestedOrgId` is honored only after a membership check. */
export async function resolveTargetOrg(
  context: McpAuthContext,
  requestedOrgId: string | null | undefined,
  cap: Capability
): Promise<string | null> {
  const orgId = requestedOrgId || context.organizationId;
  return (await canAccessOrg(context, orgId, cap)) ? orgId : null;
}

export function accessDenied(resource: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: `${resource} not found or access denied` }),
      },
    ],
    isError: true as const,
  };
}

/** The app's org, or null if out of scope. */
export async function resolveAppOrg(
  context: McpAuthContext,
  appId: string,
  cap: Capability
): Promise<string | null> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
    columns: { organizationId: true },
  });

  if (!app) return null;
  return (await canAccessOrg(context, app.organizationId, cap))
    ? app.organizationId
    : null;
}

/** The project's org, or null if out of scope. */
export async function resolveProjectOrg(
  context: McpAuthContext,
  projectId: string,
  cap: Capability
): Promise<string | null> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { organizationId: true },
  });

  if (!project) return null;
  return (await canAccessOrg(context, project.organizationId, cap))
    ? project.organizationId
    : null;
}

/** Restricts a column to the token's organizations. */
export function orgFilter(column: PgColumn, orgIds: string[]): SQL {
  if (orgIds.length === 0) return sql`false`;
  return orgIds.length === 1 ? eq(column, orgIds[0]) : inArray(column, orgIds);
}

export type OrgLabel = { id: string; name: string; slug: string };

/** Org id to name/slug for labeling aggregated results. */
export async function orgLabels(
  orgIds: string[]
): Promise<Map<string, OrgLabel>> {
  if (orgIds.length === 0) return new Map();

  const rows = await db.query.organizations.findMany({
    where: inArray(organizations.id, orgIds),
    columns: { id: true, name: true, slug: true },
  });

  return new Map(rows.map((r) => [r.id, r]));
}
