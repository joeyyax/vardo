import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { orgDomains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const DEFAULT_DOMAIN = process.env.VARDO_BASE_DOMAIN || "localhost";

const addSchema = z.object({
  domain: z
    .string()
    .min(1)
    .transform((d) => d.trim().toLowerCase())
    .refine(
      (d) =>
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
          d
        ),
      { message: "Invalid domain format" }
    ),
}).strict();

const patchSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
}).strict();

// GET — list all org domains (includes default even if not yet in table)
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const rows = await db.query.orgDomains.findMany({
      where: eq(orgDomains.organizationId, orgId),
    });

    // Ensure the default app domain is always present in the response
    const hasDefault = rows.some((r) => r.isDefault);
    if (!hasDefault) {
      // Synthesize the default domain row (not yet persisted)
      rows.unshift({
        id: "__default__",
        organizationId: orgId,
        domain: DEFAULT_DOMAIN,
        isDefault: true,
        enabled: true,
        verified: true,
        createdAt: new Date(),
      });
    }

    // Sort: default first, then by createdAt
    rows.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return NextResponse.json({ domains: rows });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST — add a custom domain
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = addSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const domain = parsed.data.domain;

    // Don't allow adding the default domain as a custom domain
    if (domain === DEFAULT_DOMAIN) {
      return NextResponse.json(
        { error: "Cannot add the default domain as a custom domain" },
        { status: 400 }
      );
    }

    const [created] = await db
      .insert(orgDomains)
      .values({
        id: nanoid(),
        organizationId: orgId,
        domain,
        isDefault: false,
        enabled: true,
        verified: false,
      })
      .returning();

    return NextResponse.json({ domain: created }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      return NextResponse.json(
        { error: "Domain already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error);
  }
}

// PATCH — toggle enabled/disabled
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // If toggling the default domain that hasn't been persisted yet, create it
    if (parsed.data.id === "__default__") {
      const [created] = await db
        .insert(orgDomains)
        .values({
          id: nanoid(),
          organizationId: orgId,
          domain: DEFAULT_DOMAIN,
          isDefault: true,
          enabled: parsed.data.enabled,
          verified: true,
        })
        .returning();

      return NextResponse.json({ domain: created });
    }

    const [updated] = await db
      .update(orgDomains)
      .set({ enabled: parsed.data.enabled })
      .where(
        and(
          eq(orgDomains.id, parsed.data.id),
          eq(orgDomains.organizationId, orgId)
        )
      )
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ domain: updated });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      // Default domain already persisted, just update it
      const { orgId } = await params;
      const body = await request.json();
      const [updated] = await db
        .update(orgDomains)
        .set({ enabled: body.enabled })
        .where(
          and(
            eq(orgDomains.organizationId, orgId),
            eq(orgDomains.isDefault, true)
          )
        )
        .returning();

      if (updated) return NextResponse.json({ domain: updated });
    }
    return handleRouteError(error);
  }
}

// DELETE — remove a custom domain (cannot delete default)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { id } = await request.json();

    // Check if trying to delete the default domain
    const existing = await db.query.orgDomains.findFirst({
      where: and(
        eq(orgDomains.id, id),
        eq(orgDomains.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (existing.isDefault) {
      return NextResponse.json(
        { error: "Cannot delete the default domain" },
        { status: 400 }
      );
    }

    await db
      .delete(orgDomains)
      .where(
        and(eq(orgDomains.id, id), eq(orgDomains.organizationId, orgId))
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
