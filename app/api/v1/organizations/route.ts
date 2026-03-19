import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organizations, memberships, user } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

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
    console.error("Error fetching organizations:", error);
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
    const { name, slug: providedSlug } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Organization name is required" },
        { status: 400 }
      );
    }

    const trimmedName = name.trim();

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
    console.error("Error creating organization:", error);
    return NextResponse.json(
      { error: "Failed to create organization" },
      { status: 500 }
    );
  }
}
