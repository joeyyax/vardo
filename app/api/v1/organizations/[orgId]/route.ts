import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { organizations, memberships } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { requireAppAdmin } from "@/lib/auth/admin";
import { recordActivity } from "@/lib/activity";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";

const log = logger.child("api:organizations");

const updateOrgSchema = z.object({
  name: z.string().min(1, "Organization name cannot be empty").max(100).trim().optional(),
  baseDomain: z.union([
    z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Invalid domain format").transform(s => s.toLowerCase()),
    z.literal(""),
    z.null(),
  ]).optional(),
  trusted: z.boolean().optional(),
}).strict().refine(data => Object.keys(data).length > 0, { message: "No valid updates provided" });

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

async function verifyOrgAccess(userId: string, orgId: string) {
  return db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, userId),
      eq(memberships.organizationId, orgId)
    ),
  });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { orgId } = await params;
    const membership = await verifyOrgAccess(session.user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    return NextResponse.json({
      organization: org,
      membership: { id: membership.id, role: membership.role },
    });
  } catch (error) {
    log.error("Error fetching organization:", error);
    return NextResponse.json({ error: "Failed to fetch organization" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { orgId } = await params;
    const membership = await verifyOrgAccess(session.user.id, orgId);
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = updateOrgSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    // trusted is a security boundary — only platform admins may change it
    if (parsed.data.trusted !== undefined) {
      try {
        await requireAppAdmin();
      } catch {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const updates: Partial<typeof organizations.$inferInsert> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.baseDomain !== undefined) {
      updates.baseDomain = parsed.data.baseDomain === "" ? null : parsed.data.baseDomain;
    }
    if (parsed.data.trusted !== undefined) updates.trusted = parsed.data.trusted;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid updates provided" }, { status: 400 });
    }

    updates.updatedAt = new Date();

    const [org] = await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, orgId))
      .returning();

    if (parsed.data.trusted !== undefined) {
      recordActivity({
        organizationId: orgId,
        action: "org.trusted_changed",
        userId: session.user.id,
        metadata: { trusted: parsed.data.trusted },
      });
    }

    return NextResponse.json({ organization: org });
  } catch (error) {
    log.error("Error updating organization:", error);
    return NextResponse.json({ error: "Failed to update organization" }, { status: 500 });
  }
}
