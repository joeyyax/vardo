import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { isAppAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/permissions";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { handleRouteError } from "@/lib/api/error-response";
import { recordActivity } from "@/lib/activity";
import { eq } from "drizzle-orm";

import { withRateLimit } from "@/lib/api/with-rate-limit";

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

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const access = await verifyOrgAccess(orgId);
    if (!access) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({
      organization: access.organization,
      membership: { id: access.membership.id, role: access.membership.role },
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching organization");
  }
}

async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await requireSession();
    const { orgId } = await params;

    const body = await request.json();
    const parsed = updateOrgSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    // trusted is a security boundary. Instance admins set it on any org from the admin panel.
    if (parsed.data.trusted !== undefined && !(await isAppAdmin())) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const trustedOnly = Object.keys(parsed.data).every((k) => k === "trusted");
    if (!trustedOnly) {
      const access = await verifyOrgAccess(orgId);
      if (!access || !isOrgAdmin(access.membership.role)) {
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

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

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
    return handleRouteError(error, "Error updating organization");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations" });
