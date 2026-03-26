import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { regenerateAppRouteConfig } from "@/lib/traefik/generate-config";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const createDomainSchema = z.object({
  domain: z.string().min(1, "Domain is required").regex(HOSTNAME_RE, "Invalid domain name"),
  serviceName: z.string().optional(),
  port: z.number().int().positive().optional(),
  certResolver: z.string().default("le"),
}).strict();

const deleteDomainSchema = z.object({
  id: z.string().min(1),
}).strict();

// POST /api/v1/organizations/[orgId]/apps/[appId]/domains
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = createDomainSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [created] = await db
      .insert(domains)
      .values({
        id: nanoid(),
        appId,
        domain: parsed.data.domain,
        serviceName: parsed.data.serviceName,
        port: parsed.data.port,
        certResolver: parsed.data.certResolver,
      })
      .returning();

    // Regenerate Traefik file-provider config so the new domain takes effect
    // immediately without a redeploy
    regenerateAppRouteConfig(appId).catch((err) => logger.child("traefik").error("Failed to regenerate route config:", err));

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
    return handleRouteError(error, "Error creating domain");
  }
}

const updateDomainSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1).optional(),
  port: z.number().int().positive().nullable().optional(),
  certResolver: z.string().optional(),
}).strict();

// PATCH /api/v1/organizations/[orgId]/apps/[appId]/domains
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = updateDomainSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { id, ...updates } = parsed.data;

    const [updated] = await db
      .update(domains)
      .set(updates)
      .where(and(eq(domains.id, id), eq(domains.appId, appId)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Regenerate Traefik config so domain changes take effect immediately
    regenerateAppRouteConfig(appId).catch((err) => logger.child("traefik").error("Failed to regenerate route config:", err));

    return NextResponse.json({ domain: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating domain");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/domains
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = deleteDomainSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [deleted] = await db
      .delete(domains)
      .where(
        and(
          eq(domains.id, parsed.data.id),
          eq(domains.appId, appId)
        )
      )
      .returning({ id: domains.id });

    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Regenerate Traefik config (removes the deleted domain's routing)
    regenerateAppRouteConfig(appId).catch((err) => logger.child("traefik").error("Failed to regenerate route config:", err));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting domain");
  }
}
