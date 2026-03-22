import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { groups, groupEnvironments } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { createGroupEnvironment } from "@/lib/docker/clone";

type RouteParams = {
  params: Promise<{ orgId: string; groupId: string }>;
};

const createEnvSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  type: z.enum(["staging", "preview"]).default("staging"),
  sourceEnvironment: z.string().optional(),
});

// GET /api/v1/organizations/[orgId]/groups/[groupId]/environments
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, groupId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify group belongs to org
    const group = await db.query.groups.findFirst({
      where: and(eq(groups.id, groupId), eq(groups.organizationId, orgId)),
      columns: { id: true },
    });

    if (!group) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const envs = await db.query.groupEnvironments.findMany({
      where: eq(groupEnvironments.groupId, groupId),
      with: {
        environments: {
          columns: {
            id: true,
            projectId: true,
            name: true,
            type: true,
            domain: true,
          },
        },
      },
    });

    return NextResponse.json({ environments: envs });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching group environments:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/groups/[groupId]/environments
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, groupId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createEnvSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const result = await createGroupEnvironment({
      groupId,
      organizationId: orgId,
      name: parsed.data.name,
      type: parsed.data.type,
      sourceEnvironment: parsed.data.sourceEnvironment,
      createdBy: session.user.id,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      return NextResponse.json(
        { error: "An environment with this name already exists" },
        { status: 409 }
      );
    }
    console.error("Error creating group environment:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
