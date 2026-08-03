import { db } from "@/lib/db";
import { apps, memberships, organizations, projects } from "@/lib/db/schema";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { McpAuthContext } from "./auth";

/**
 * Organization scoping for MCP tools.
 *
 * A token reaches an organization only while its user holds a live membership
 * there. A normal token is additionally pinned to the organization it was
 * minted for; a cross-org token is not. Both are re-checked against the
 * database on every request, so removing a membership revokes access at once.
 *
 * WARNING: every tool's tenancy boundary runs through canAccessOrg and
 * accessibleOrgIds. Widening either widens all MCP tools at once.
 */

/** True when the token may act on `orgId`. */
export async function canAccessOrg(
  context: McpAuthContext,
  orgId: string
): Promise<boolean> {
  if (!context.crossOrg && orgId !== context.organizationId) return false;

  const membership = await db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, context.userId),
      eq(memberships.organizationId, orgId)
    ),
    columns: { id: true },
  });

  return membership != null;
}

/** Every organization the token may act on, resolved from live memberships. */
export async function accessibleOrgIds(
  context: McpAuthContext
): Promise<string[]> {
  const rows = await db.query.memberships.findMany({
    where: eq(memberships.userId, context.userId),
    columns: { organizationId: true },
  });

  const memberOrgIds = [...new Set(rows.map((r) => r.organizationId))];

  return context.crossOrg
    ? memberOrgIds
    : memberOrgIds.filter((id) => id === context.organizationId);
}

/** The token user's role in `orgId`, or null when they have no membership there. */
export async function orgRole(
  context: McpAuthContext,
  orgId: string
): Promise<string | null> {
  const membership = await db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, context.userId),
      eq(memberships.organizationId, orgId)
    ),
    columns: { role: true },
  });

  return membership?.role ?? null;
}

/**
 * Resolve the organization to create a new resource in. `requestedOrgId` is
 * caller-supplied and is only honored after a membership check.
 */
export async function resolveTargetOrg(
  context: McpAuthContext,
  requestedOrgId?: string | null
): Promise<string | null> {
  const orgId = requestedOrgId || context.organizationId;
  return (await canAccessOrg(context, orgId)) ? orgId : null;
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

/** Resolve the organization an app belongs to, or null if out of scope. */
export async function resolveAppOrg(
  context: McpAuthContext,
  appId: string
): Promise<string | null> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
    columns: { organizationId: true },
  });

  if (!app) return null;
  return (await canAccessOrg(context, app.organizationId))
    ? app.organizationId
    : null;
}

/** Resolve the organization a project belongs to, or null if out of scope. */
export async function resolveProjectOrg(
  context: McpAuthContext,
  projectId: string
): Promise<string | null> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { organizationId: true },
  });

  if (!project) return null;
  return (await canAccessOrg(context, project.organizationId))
    ? project.organizationId
    : null;
}

/**
 * Restrict a column to the token's organizations. A single-org token collapses
 * to the equality filter it uses today.
 */
export function orgFilter(column: PgColumn, orgIds: string[]): SQL {
  if (orgIds.length === 0) return sql`false`;
  return orgIds.length === 1 ? eq(column, orgIds[0]) : inArray(column, orgIds);
}

export type OrgLabel = { id: string; name: string; slug: string };

/** Org id → name/slug, so aggregated list results say which org each row is in. */
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
