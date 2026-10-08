import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { refuseSystemManaged } from "@/lib/api/system-managed";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { apps } from "@/lib/db/schema";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { HOSTNAME_RE } from "@/lib/security/hostname";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};


const createDomainSchema = z.object({
  domain: z.string().min(1, "Domain is required").regex(HOSTNAME_RE, "Invalid domain name"),
  serviceName: z.string().optional(),
  port: z.number().int().positive().optional(),
  certResolver: z.string().optional(),
  redirectTo: z.string().url("Must be a valid URL").optional(),
  redirectCode: z.union([z.literal(301), z.literal(302)]).optional(),
}).strict();

const deleteDomainSchema = z.object({
  id: z.string().min(1),
}).strict();

// POST /api/v1/organizations/[orgId]/apps/[appId]/domains
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.domains");

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "domains");
    if (refused) return refused;

    const body = await request.json();
    const parsed = createDomainSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    // Redirect domains can't self-reference.
    if (parsed.data.redirectTo) {
      try {
        const targetHost = new URL(parsed.data.redirectTo).hostname;
        if (targetHost === parsed.data.domain) {
          return NextResponse.json(
            { error: "Redirect target can't be the same domain (infinite redirect loop)" },
            { status: 400 }
          );
        }
      } catch {
        // URL parsing handled by zod
      }
    }

    // Caller's resolver, or the system primary issuer.
    const certResolver = parsed.data.certResolver
      ?? getPrimaryIssuer(await getSslConfig());

    const [created] = await db
      .insert(domains)
      .values({
        id: nanoid(),
        appId,
        domain: parsed.data.domain,
        serviceName: parsed.data.serviceName,
        port: parsed.data.port,
        certResolver,
        redirectTo: parsed.data.redirectTo,
        redirectCode: parsed.data.redirectCode,
      })
      .returning();

    // Traefik labels route traffic, so domain changes need a redeploy.
    await db.update(apps).set({ needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, appId));

    return NextResponse.json({ domain: created }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
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
  domain: z.string().min(1).regex(HOSTNAME_RE, "Invalid domain name").optional(),
  port: z.number().int().positive().nullable().optional(),
  certResolver: z.string().optional(),
  redirectTo: z.string().url("Must be a valid URL").nullable().optional(),
  redirectCode: z.union([z.literal(301), z.literal(302)]).optional(),
}).strict();

// PATCH /api/v1/organizations/[orgId]/apps/[appId]/domains
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.domains");

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "domains");
    if (refused) return refused;

    const body = await request.json();
    const parsed = updateDomainSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const { id, ...updates } = parsed.data;

    // Prevent self-redirect
    if (updates.redirectTo) {
      const existing = await db.query.domains.findFirst({
        where: and(eq(domains.id, id), eq(domains.appId, appId)),
        columns: { domain: true },
      });
      if (existing) {
        const redirectHost = new URL(updates.redirectTo).hostname;
        if (redirectHost === existing.domain) {
          return NextResponse.json({ error: "Can't redirect a domain to itself" }, { status: 400 });
        }
      }
    }

    const [updated] = await db
      .update(domains)
      .set(updates)
      .where(and(eq(domains.id, id), eq(domains.appId, appId)))
      .returning();

    if (!updated) {
      return apiError.notFound("domain");
    }

    // Domain changes require a redeploy to update Traefik labels
    await db.update(apps).set({ needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, appId));

    return NextResponse.json({ domain: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating domain");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/domains
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.domains");

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "domains");
    if (refused) return refused;

    const body = await request.json();
    const parsed = deleteDomainSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
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
      return apiError.notFound("domain");
    }

    // Domain deletion requires a redeploy to remove Traefik labels
    await db.update(apps).set({ needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, appId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting domain");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-domains" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "apps-domains" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-domains" });
