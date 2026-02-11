import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { scopeClients, clients, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { generateScopeToken } from "@/lib/scope-tokens";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/scope-clients
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get("clientId");

    const conditions = [eq(scopeClients.organizationId, orgId)];
    if (clientId) {
      conditions.push(eq(scopeClients.clientId, clientId));
    }

    const results = await db.query.scopeClients.findMany({
      where: and(...conditions),
      with: {
        defaultProject: { columns: { id: true, name: true } },
        client: { columns: { id: true, name: true } },
      },
      orderBy: (sc, { desc }) => [desc(sc.createdAt)],
    });

    return NextResponse.json(results);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error listing scope clients:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/scope-clients
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { name, clientId, defaultProjectId, domains, publicAccess } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!clientId) {
      return NextResponse.json({ error: "Client ID is required" }, { status: 400 });
    }

    // Verify client belongs to this org
    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, clientId), eq(clients.organizationId, orgId)),
    });

    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    // Verify default project if provided
    if (defaultProjectId) {
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, defaultProjectId), eq(projects.clientId, clientId)),
      });

      if (!project) {
        return NextResponse.json({ error: "Project not found or doesn't belong to this client" }, { status: 400 });
      }
    }

    const token = generateScopeToken();

    const [created] = await db
      .insert(scopeClients)
      .values({
        organizationId: orgId,
        clientId,
        defaultProjectId: defaultProjectId || null,
        name: name.trim(),
        token,
        domains: Array.isArray(domains) ? domains : [],
        publicAccess: publicAccess === true,
      })
      .returning();

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating scope client:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
