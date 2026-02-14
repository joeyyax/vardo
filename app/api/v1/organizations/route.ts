import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organizations, memberships, users, DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, sql } from "drizzle-orm";

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

    // Find all memberships for this user with their organizations
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
    const { name, features } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Organization name is required" },
        { status: 400 }
      );
    }

    const trimmedName = name.trim();

    // Merge provided features with defaults
    const orgFeatures: OrgFeatures = {
      ...DEFAULT_ORG_FEATURES,
      ...(features && typeof features === "object" ? features : {}),
    };

    // Ensure boolean feature values are booleans
    const booleanFeatureKeys = ["time_tracking", "invoicing", "expenses", "pm", "proposals"] as const;
    for (const key of booleanFeatureKeys) {
      orgFeatures[key] = Boolean(orgFeatures[key]);
    }

    // Auto-set defaultAssignee to the creating user (single-user org)
    orgFeatures.defaultAssignee = session.user.id;

    // Check if this is the first organization in the system
    const [{ count: orgCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(organizations);
    const isFirstOrg = orgCount === 0;

    // Generate a slug from the name
    const baseSlug = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Add a random suffix to ensure uniqueness
    const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 8)}`;

    // Create the organization
    const [org] = await db
      .insert(organizations)
      .values({
        name: trimmedName,
        slug,
        roundingIncrement: 15, // default 15 minutes
        features: orgFeatures,
      })
      .returning();

    // Create the membership (user is owner)
    await db.insert(memberships).values({
      userId: session.user.id,
      organizationId: org.id,
      role: "owner",
    });

    // If this is the first organization, make the user an app admin
    if (isFirstOrg) {
      await db
        .update(users)
        .set({ isAppAdmin: true })
        .where(eq(users.id, session.user.id));
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
