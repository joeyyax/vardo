import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { envVars, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { parseEnvContent } from "@/lib/env/parse-env-content";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

const createEnvVarSchema = z.object({
  key: z
    .string()
    .min(1, "Key is required")
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid variable name"),
  value: z.string(),
  isSecret: z.boolean().default(true),
});

const updateEnvVarSchema = z.object({
  id: z.string().min(1),
  value: z.string(),
});

const deleteEnvVarSchema = z.object({
  id: z.string().min(1),
});

const bulkEnvVarSchema = z.object({
  key: z
    .string()
    .min(1, "Key is required")
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid variable name"),
  value: z.string(),
  isSecret: z.boolean().default(true),
});

const bulkUpsertSchema = z
  .object({
    content: z.string().optional(),
    vars: z.array(bulkEnvVarSchema).optional(),
  })
  .refine((data) => data.content !== undefined || data.vars !== undefined, {
    message: "Either 'content' or 'vars' must be provided",
  });

async function verifyProjectAccess(orgId: string, projectId: string) {
  const { organization } = await requireOrg();

  if (organization.id !== orgId) {
    return null;
  }

  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.organizationId, orgId)
    ),
    columns: { id: true },
  });

  return project;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/env-vars
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const vars = await db.query.envVars.findMany({
      where: eq(envVars.projectId, projectId),
      columns: {
        id: true,
        key: true,
        isSecret: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({ envVars: vars });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching env vars:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/env-vars
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = createEnvVarSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [created] = await db
      .insert(envVars)
      .values({
        id: nanoid(),
        projectId,
        key: parsed.data.key,
        value: parsed.data.value,
        isSecret: parsed.data.isSecret,
      })
      .returning({
        id: envVars.id,
        key: envVars.key,
        isSecret: envVars.isSecret,
        createdAt: envVars.createdAt,
        updatedAt: envVars.updatedAt,
      });

    return NextResponse.json({ envVar: created }, { status: 201 });
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
        { error: "A variable with this key already exists" },
        { status: 409 }
      );
    }
    console.error("Error creating env var:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]/env-vars
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = updateEnvVarSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [updated] = await db
      .update(envVars)
      .set({ value: parsed.data.value, updatedAt: new Date() })
      .where(
        and(
          eq(envVars.id, parsed.data.id),
          eq(envVars.projectId, projectId)
        )
      )
      .returning({
        id: envVars.id,
        key: envVars.key,
        isSecret: envVars.isSecret,
        createdAt: envVars.createdAt,
        updatedAt: envVars.updatedAt,
      });

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ envVar: updated });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating env var:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/env-vars
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = deleteEnvVarSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [deleted] = await db
      .delete(envVars)
      .where(
        and(
          eq(envVars.id, parsed.data.id),
          eq(envVars.projectId, projectId)
        )
      )
      .returning({ id: envVars.id });

    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting env var:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PUT /api/v1/organizations/[orgId]/projects/[projectId]/env-vars
// Bulk upsert env vars from raw .env content or structured array
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = bulkUpsertSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Normalize input into a consistent format
    let varsToUpsert: { key: string; value: string; isSecret: boolean }[];

    if (parsed.data.vars) {
      varsToUpsert = parsed.data.vars.map((v) => ({
        key: v.key,
        value: v.value,
        isSecret: v.isSecret,
      }));
    } else {
      const envEntries = parseEnvContent(parsed.data.content!);
      varsToUpsert = envEntries.map((entry) => ({
        key: entry.key,
        value: entry.value,
        isSecret: true, // Default to secret for parsed content
      }));
    }

    if (varsToUpsert.length === 0) {
      return NextResponse.json({ created: 0, updated: 0 });
    }

    // Fetch existing vars for this project to determine insert vs update
    const existingVars = await db.query.envVars.findMany({
      where: eq(envVars.projectId, projectId),
      columns: { id: true, key: true },
    });

    const existingByKey = new Map(existingVars.map((v) => [v.key, v.id]));

    let created = 0;
    let updated = 0;

    await db.transaction(async (tx) => {
      for (const v of varsToUpsert) {
        const existingId = existingByKey.get(v.key);

        if (existingId) {
          await tx
            .update(envVars)
            .set({
              value: v.value,
              isSecret: v.isSecret,
              updatedAt: new Date(),
            })
            .where(
              and(eq(envVars.id, existingId), eq(envVars.projectId, projectId))
            );
          updated++;
        } else {
          await tx.insert(envVars).values({
            id: nanoid(),
            projectId,
            key: v.key,
            value: v.value,
            isSecret: v.isSecret,
          });
          created++;
        }
      }
    });

    return NextResponse.json({ created, updated });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error bulk upserting env vars:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
