import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reportConfigs } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and, desc } from "drizzle-orm";
import { randomBytes } from "crypto";

function generateSlug(): string {
  return randomBytes(9).toString("base64url"); // 12 URL-safe characters
}

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/reports - List report configs
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const configs = await db.query.reportConfigs.findMany({
      where: eq(reportConfigs.organizationId, orgId),
      with: {
        client: true,
        project: true,
      },
      orderBy: [desc(reportConfigs.createdAt)],
    });

    return NextResponse.json(
      configs.map((config) => ({
        id: config.id,
        slug: config.slug,
        enabled: config.enabled,
        showRates: config.showRates,
        autoSend: config.autoSend,
        autoSendDay: config.autoSendDay,
        autoSendHour: config.autoSendHour,
        recipients: config.recipients,
        clientId: config.clientId,
        projectId: config.projectId,
        client: config.client
          ? { id: config.client.id, name: config.client.name, color: config.client.color }
          : null,
        project: config.project
          ? { id: config.project.id, name: config.project.name }
          : null,
        createdAt: config.createdAt.toISOString(),
      }))
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error fetching report configs:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/reports - Create report config
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const {
      clientId,
      projectId,
      showRates = false,
      autoSend = false,
      autoSendDay,
      autoSendHour,
      recipients = [],
    } = body;

    // Must have either clientId or projectId
    if (!clientId && !projectId) {
      return NextResponse.json(
        { error: "Either clientId or projectId is required" },
        { status: 400 }
      );
    }

    // Check for existing config for this client/project
    const existingConditions = [eq(reportConfigs.organizationId, orgId)];
    if (projectId) {
      existingConditions.push(eq(reportConfigs.projectId, projectId));
    } else if (clientId) {
      existingConditions.push(eq(reportConfigs.clientId, clientId));
    }

    const existing = await db.query.reportConfigs.findFirst({
      where: and(...existingConditions),
    });

    if (existing) {
      return NextResponse.json(
        { error: "Report config already exists for this client/project" },
        { status: 409 }
      );
    }

    // Generate unique slug
    const slug = generateSlug();

    const [config] = await db
      .insert(reportConfigs)
      .values({
        organizationId: orgId,
        clientId: clientId || null,
        projectId: projectId || null,
        slug,
        enabled: true,
        showRates,
        autoSend,
        autoSendDay,
        autoSendHour,
        recipients,
      })
      .returning();

    return NextResponse.json(
      {
        id: config.id,
        slug: config.slug,
        enabled: config.enabled,
        showRates: config.showRates,
        autoSend: config.autoSend,
        autoSendDay: config.autoSendDay,
        autoSendHour: config.autoSendHour,
        recipients: config.recipients,
        createdAt: config.createdAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error creating report config:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
