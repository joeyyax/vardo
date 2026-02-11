import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { scopeClients, siteHeartbeats, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, sql } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; scopeClientId: string }>;
};

// GET /api/v1/organizations/[orgId]/scope-clients/[scopeClientId]
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, scopeClientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const sc = await db.query.scopeClients.findFirst({
      where: and(
        eq(scopeClients.id, scopeClientId),
        eq(scopeClients.organizationId, orgId)
      ),
      with: {
        defaultProject: { columns: { id: true, name: true } },
        client: { columns: { id: true, name: true } },
      },
    });

    if (!sc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Get stats
    const [stats] = await db
      .select({
        heartbeatCount: sql<number>`count(*)::int`,
        lastSeen: sql<string>`max(${siteHeartbeats.createdAt})`,
      })
      .from(siteHeartbeats)
      .where(eq(siteHeartbeats.scopeClientId, scopeClientId));

    return NextResponse.json({
      ...sc,
      stats: {
        heartbeatCount: stats?.heartbeatCount ?? 0,
        lastSeen: stats?.lastSeen ?? null,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching scope client:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/scope-clients/[scopeClientId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, scopeClientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify scope client exists and belongs to org
    const existing = await db.query.scopeClients.findFirst({
      where: and(
        eq(scopeClients.id, scopeClientId),
        eq(scopeClients.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const updates: Record<string, unknown> = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.domains !== undefined) updates.domains = body.domains;
    if (body.publicAccess !== undefined) updates.publicAccess = body.publicAccess;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    if (body.defaultProjectId !== undefined) {
      if (body.defaultProjectId) {
        // Verify project belongs to the same client
        const project = await db.query.projects.findFirst({
          where: and(
            eq(projects.id, body.defaultProjectId),
            eq(projects.clientId, existing.clientId)
          ),
        });
        if (!project) {
          return NextResponse.json(
            { error: "Project not found or doesn't belong to this client" },
            { status: 400 }
          );
        }
      }
      updates.defaultProjectId = body.defaultProjectId || null;
    }

    updates.updatedAt = new Date();

    const [updated] = await db
      .update(scopeClients)
      .set(updates)
      .where(eq(scopeClients.id, scopeClientId))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating scope client:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/scope-clients/[scopeClientId]
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, scopeClientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await db.query.scopeClients.findFirst({
      where: and(
        eq(scopeClients.id, scopeClientId),
        eq(scopeClients.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await db.delete(scopeClients).where(eq(scopeClients.id, scopeClientId));

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting scope client:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
