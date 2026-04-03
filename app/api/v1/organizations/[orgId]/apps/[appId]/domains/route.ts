import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { apps } from "@/lib/db/schema";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

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
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (app.isSystemManaged) {
      return NextResponse.json(
        { error: "Domains for system-managed apps cannot be modified via the API" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const parsed = createDomainSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Validate: redirect domains cannot be self-referencing
    if (parsed.data.redirectTo) {
      try {
        const targetHost = new URL(parsed.data.redirectTo).hostname;
        if (targetHost === parsed.data.domain) {
          return NextResponse.json(
            { error: "Redirect target cannot be the same domain (infinite redirect loop)" },
            { status: 400 }
          );
        }
      } catch {
        // URL parsing handled by zod
      }
    }

    // Use the caller-specified resolver, or fall back to the system primary issuer
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

    // Mark app for redeploy — Traefik labels are the source of truth for routing,
    // so domain changes take effect on the next deploy.
    await db.update(apps).set({ needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, appId));

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
  redirectTo: z.string().url("Must be a valid URL").nullable().optional(),
  redirectCode: z.union([z.literal(301), z.literal(302)]).optional(),
}).strict();

// PATCH /api/v1/organizations/[orgId]/apps/[appId]/domains
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (app.isSystemManaged) {
      return NextResponse.json(
        { error: "Domains for system-managed apps cannot be modified via the API" },
        { status: 403 }
      );
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

    // Prevent self-redirect
    if (updates.redirectTo) {
      const existing = await db.query.domains.findFirst({
        where: and(eq(domains.id, id), eq(domains.appId, appId)),
        columns: { domain: true },
      });
      if (existing) {
        const redirectHost = new URL(updates.redirectTo).hostname;
        if (redirectHost === existing.domain) {
          return NextResponse.json({ error: "Cannot redirect a domain to itself" }, { status: 400 });
        }
      }
    }

    const [updated] = await db
      .update(domains)
      .set(updates)
      .where(and(eq(domains.id, id), eq(domains.appId, appId)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Domain changes require a redeploy to update Traefik labels
    await db.update(apps).set({ needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, appId));

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

    if (app.isSystemManaged) {
      return NextResponse.json(
        { error: "Domains for system-managed apps cannot be modified via the API" },
        { status: 403 }
      );
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

    // Domain deletion requires a redeploy to remove Traefik labels
    await db.update(apps).set({ needsRedeploy: true, updatedAt: new Date() }).where(eq(apps.id, appId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting domain");
  }
}
