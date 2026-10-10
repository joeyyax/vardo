import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isValidTimeZone } from "@/lib/time-zone";
import { db } from "@/lib/db";
import { organizations, RESOURCE_PROFILES } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { isAppAdmin } from "@/lib/auth/admin";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { recordActivity } from "@/lib/activity";
import { eq } from "drizzle-orm";
import { loadInstanceHosts } from "@/lib/domains/context";
import { newChallengeToken, refusedHost } from "@/lib/domains/ownership";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const updateOrgSchema = z.object({
  name: z.string().min(1, "Organization name can't be empty").max(100).trim().optional(),
  baseDomain: z.union([
    z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Invalid domain format").transform(s => s.toLowerCase()),
    z.literal(""),
    z.null(),
  ]).optional(),
  trusted: z.boolean().optional(),
  // Null follows the instance.
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone").nullable().optional(),
  memoryProfile: z.enum(RESOURCE_PROFILES).optional(),
  // MB. Null leaves only the host cap.
  memoryAutoMaxMb: z.number().int().min(64).max(1048576).nullable().optional(),
}).strict().refine(data => Object.keys(data).length > 0, { message: "No valid updates provided" });

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const access = await verifyOrgAccess(orgId, "org.view");
    if (!access) {
      return apiError.forbidden();
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
      return apiError.validation(parsed.error, { details: true });
    }

    // trusted is a security boundary. Only instance admins set it.
    if (parsed.data.trusted !== undefined && !(await isAppAdmin())) {
      return apiError.forbidden();
    }

    const trustedOnly = Object.keys(parsed.data).every((k) => k === "trusted");
    if (!trustedOnly) {
      const access = await verifyOrgAccess(orgId, "org.settings");
      if (!access) {
        return apiError.forbidden();
      }
    }

    const updates: Partial<typeof organizations.$inferInsert> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.baseDomain !== undefined) {
      const next = parsed.data.baseDomain === "" ? null : parsed.data.baseDomain;
      const current = await db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { baseDomain: true },
      });
      if (!current) {
        return NextResponse.json({ error: "Organization not found" }, { status: 404 });
      }
      // Re-saving the stored value stays allowed. A changed one starts a new challenge.
      if (next !== current.baseDomain) {
        const refusal = next ? refusedHost(next, await loadInstanceHosts()) : null;
        if (refusal) {
          return NextResponse.json({ error: `Couldn't set base domain. ${refusal}` }, { status: 400 });
        }
        updates.baseDomain = next;
        updates.baseDomainToken = next ? newChallengeToken() : null;
        updates.baseDomainVerifiedAt = null;
      }
    }
    if (parsed.data.trusted !== undefined) updates.trusted = parsed.data.trusted;
    if (parsed.data.timeZone !== undefined) updates.timeZone = parsed.data.timeZone;
    if (parsed.data.memoryProfile !== undefined) updates.memoryProfile = parsed.data.memoryProfile;
    if (parsed.data.memoryAutoMaxMb !== undefined) updates.memoryAutoMaxMb = parsed.data.memoryAutoMaxMb;

    if (Object.keys(updates).length === 0 && parsed.data.baseDomain === undefined) {
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

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*" });
