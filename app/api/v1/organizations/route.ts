import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { organizations, memberships } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logger } from "@/lib/logger";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const log = logger.child("api:organizations");

const createOrgSchema = z.object({
  name: z.string().min(1, "Organization name is required").max(100).trim(),
  slug: z.string().max(100).regex(/^[a-z0-9-]*$/, "Slug must contain only lowercase letters, numbers, and hyphens").optional(),
}).strict();

/** GET /api/v1/organizations — orgs the user belongs to. */
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

    const showSystemOrgs = await isFeatureEnabledAsync("selfManagement");

    const orgs = userMemberships
      .filter((m) => showSystemOrgs || !m.organization.isSystemManaged)
      .map((m) => ({
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

/** POST /api/v1/organizations — creates an org owned by the user. */
async function handlePost(request: NextRequest) {
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

    const baseSlug = (providedSlug || trimmedName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // A short suffix keeps the slug unique.
    const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 8)}`;

    const [org] = await db
      .insert(organizations)
      .values({
        id: nanoid(),
        name: trimmedName,
        slug,
      })
      .returning();

    await db.insert(memberships).values({
      id: nanoid(),
      userId: session.user.id,
      organizationId: org.id,
      role: "owner",
    });

    return NextResponse.json({ organization: org }, { status: 201 });
  } catch (error) {
    log.error("Error creating organization:", error);
    return NextResponse.json(
      { error: "Failed to create organization" },
      { status: 500 }
    );
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations" });
