import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { organizations, memberships, user } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logger } from "@/lib/logger";

const log = logger.child("api:organizations");

const createOrgSchema = z.object({
  name: z.string().min(1, "Organization name is required").max(100).trim(),
  slug: z.string().max(100).regex(/^[a-z0-9-]*$/, "Slug must contain only lowercase letters, numbers, and hyphens").optional(),
}).strict();

/**
 * GET /api/v1/organizations
 * List all organizations the authenticated user belongs to.
 */
export async function GET() {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userMemberships = await db.query.memberships.findMany({
      where: eq(memberships.userId, session.user.id),
      with: {
        organization: true,
      },
    });

    const orgs = userMemberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
    }));

    return NextResponse.json({ organizations: orgs });
  } catch (error) {
    log.error("Error fetching organizations:", error);
    return NextResponse.json(
      { error: "Failed to fetch organizations" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/organizations
 * Create a new organization for the authenticated user.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = createOrgSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { name: trimmedName, slug: providedSlug } = parsed.data;

    // Use provided slug or generate from name
    const baseSlug = (providedSlug || trimmedName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Add a short suffix to ensure uniqueness
    const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 8)}`;

    // Check if this is the first org (make user app admin)
    const [{ count: orgCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(organizations);
    const isFirstOrg = orgCount === 0;

    // Create the organization
    const [org] = await db
      .insert(organizations)
      .values({
        id: nanoid(),
        name: trimmedName,
        slug,
      })
      .returning();

    // Create the membership (user is owner)
    await db.insert(memberships).values({
      id: nanoid(),
      userId: session.user.id,
      organizationId: org.id,
      role: "owner",
    });

    // If first org, make user app admin
    if (isFirstOrg) {
      await db
        .update(user)
        .set({ isAppAdmin: true })
        .where(eq(user.id, session.user.id));
    }

    return NextResponse.json({ organization: org, isAppAdmin: isFirstOrg }, { status: 201 });
  } catch (error) {
    log.error("Error creating organization:", error);
    return NextResponse.json(
      { error: "Failed to create organization" },
      { status: 500 }
    );
  }
}
