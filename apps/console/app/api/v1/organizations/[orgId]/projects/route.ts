import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const createProjectSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Name must be lowercase alphanumeric with hyphens"),
  displayName: z.string().min(1, "Display name is required"),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).strict();

// GET /api/v1/organizations/[orgId]/projects
// Lists projects (groups) in the org with their apps
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const projectList = await db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      with: {
        apps: {
          columns: { id: true, name: true, displayName: true, status: true },
        },
        groupEnvironments: true,
      },
      orderBy: [desc(projects.createdAt)],
    });

    return NextResponse.json({ projects: projectList });
  } catch (error) {
    return handleRouteError(error, "Error fetching projects");
  }
}

// POST /api/v1/organizations/[orgId]/projects
// Creates a new project (group) with name, displayName, color, description
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createProjectSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const data = parsed.data;

    const [project] = await db
      .insert(projects)
      .values({
        id: nanoid(),
        organizationId: orgId,
        name: data.name,
        displayName: data.displayName,
        description: data.description,
        color: data.color || "#6366f1",
      })
      .returning();

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    const pgCode = error instanceof Error
      ? ("code" in error ? (error as { code: string }).code : null) ??
        (error.cause && typeof error.cause === "object" && "code" in error.cause ? (error.cause as { code: string }).code : null)
      : null;
    if (pgCode === "23505") {
      return NextResponse.json(
        { error: "A project with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error creating project");
  }
}
