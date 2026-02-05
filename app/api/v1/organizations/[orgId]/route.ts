import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organizations, memberships } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

/**
 * Verify the user has access to the organization.
 * Returns the membership if found, null otherwise.
 */
async function verifyOrgAccess(userId: string, orgId: string) {
  return db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, userId),
      eq(memberships.organizationId, orgId)
    ),
  });
}

/**
 * GET /api/v1/organizations/[orgId]
 * Get organization details.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { orgId } = await params;

    // Verify user has access
    const membership = await verifyOrgAccess(session.user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get the organization
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });

    if (!org) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      organization: org,
      membership: {
        id: membership.id,
        role: membership.role,
      },
    });
  } catch (error) {
    console.error("Error fetching organization:", error);
    return NextResponse.json(
      { error: "Failed to fetch organization" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/v1/organizations/[orgId]
 * Update organization settings.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { orgId } = await params;

    // Verify user has access (must be owner or admin to update)
    const membership = await verifyOrgAccess(session.user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (membership.role !== "owner" && membership.role !== "admin") {
      return NextResponse.json(
        { error: "Only owners and admins can update organization settings" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const updates: Partial<typeof organizations.$inferInsert> = {};

    // Validate and apply name update
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return NextResponse.json(
          { error: "Organization name cannot be empty" },
          { status: 400 }
        );
      }
      updates.name = body.name.trim();
    }

    // Validate and apply default rate (stored in cents)
    if (body.defaultRate !== undefined) {
      if (body.defaultRate !== null) {
        const rate = Number(body.defaultRate);
        if (isNaN(rate) || rate < 0) {
          return NextResponse.json(
            { error: "Default rate must be a positive number or null" },
            { status: 400 }
          );
        }
        updates.defaultRate = Math.round(rate);
      } else {
        updates.defaultRate = null;
      }
    }

    // Validate and apply rounding increment
    if (body.roundingIncrement !== undefined) {
      const validIncrements = [5, 10, 15, 30, 60];
      const increment = Number(body.roundingIncrement);
      if (!validIncrements.includes(increment)) {
        return NextResponse.json(
          { error: `Rounding increment must be one of: ${validIncrements.join(", ")}` },
          { status: 400 }
        );
      }
      updates.roundingIncrement = increment;
    }

    // Validate and apply billing defaults
    if (body.defaultBillingType !== undefined) {
      const validTypes = ["hourly", "retainer_fixed", "retainer_capped", "retainer_uncapped", "fixed_project"];
      if (body.defaultBillingType !== null && !validTypes.includes(body.defaultBillingType)) {
        return NextResponse.json(
          { error: `Billing type must be one of: ${validTypes.join(", ")}` },
          { status: 400 }
        );
      }
      updates.defaultBillingType = body.defaultBillingType;
    }

    if (body.defaultBillingFrequency !== undefined) {
      const validFrequencies = ["weekly", "biweekly", "monthly", "quarterly", "per_project"];
      if (body.defaultBillingFrequency !== null && !validFrequencies.includes(body.defaultBillingFrequency)) {
        return NextResponse.json(
          { error: `Billing frequency must be one of: ${validFrequencies.join(", ")}` },
          { status: 400 }
        );
      }
      updates.defaultBillingFrequency = body.defaultBillingFrequency;
    }

    if (body.defaultPaymentTermsDays !== undefined) {
      if (body.defaultPaymentTermsDays !== null) {
        const days = Number(body.defaultPaymentTermsDays);
        if (isNaN(days) || days < 0 || days > 365) {
          return NextResponse.json(
            { error: "Payment terms must be between 0 and 365 days" },
            { status: 400 }
          );
        }
        updates.defaultPaymentTermsDays = days;
      } else {
        updates.defaultPaymentTermsDays = null;
      }
    }

    // Apply updates
    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "No valid updates provided" },
        { status: 400 }
      );
    }

    updates.updatedAt = new Date();

    const [org] = await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, orgId))
      .returning();

    return NextResponse.json({ organization: org });
  } catch (error) {
    console.error("Error updating organization:", error);
    return NextResponse.json(
      { error: "Failed to update organization" },
      { status: 500 }
    );
  }
}
