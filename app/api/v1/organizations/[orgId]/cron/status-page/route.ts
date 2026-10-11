import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { apiError, handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { isAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { cronStatusPages, domains, externalRoutes } from "@/lib/db/schema";
import { getInstanceConfig } from "@/lib/system-settings";
import { isHostname } from "@/lib/security/hostname";
import { logger } from "@/lib/logger";
import { newStatusToken } from "@/lib/cron/public-status";
import { syncStatusRoutes } from "@/lib/cron/status-route";

const log = logger.child("cron-status");

type RouteParams = { params: Promise<{ orgId: string }> };

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .refine((h) => h === "" || isHostname(h), "Enter a hostname like cron.example.com")
    .nullable()
    .optional(),
  rotate: z.literal(true).optional(),
});

async function serialize(row: typeof cronStatusPages.$inferSelect | undefined) {
  return {
    enabled: row?.enabled ?? false,
    token: row?.token ?? null,
    hostname: row?.hostname ?? null,
    canSetHostname: await isAppAdmin(),
  };
}

/** Why a host can't serve the page, or null. */
async function hostnameConflict(hostname: string, organizationId: string): Promise<string | null> {
  const consoleHost = (await getInstanceConfig().catch(() => null))?.domain || process.env.VARDO_DOMAIN;
  if (consoleHost && hostname === consoleHost.toLowerCase()) return "That's the console's own hostname";
  const [domain, route, page] = await Promise.all([
    db.query.domains.findFirst({ where: eq(domains.domain, hostname), columns: { id: true } }),
    db.query.externalRoutes.findFirst({ where: eq(externalRoutes.hostname, hostname), columns: { id: true } }),
    db.query.cronStatusPages.findFirst({ where: eq(cronStatusPages.hostname, hostname), columns: { organizationId: true } }),
  ]);
  if (domain) return "An app already uses that hostname";
  if (route) return "An external route already uses that hostname";
  if (page && page.organizationId !== organizationId) return "Another organization's status page uses that hostname";
  return null;
}

// GET /api/v1/organizations/[orgId]/cron/status-page
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;
    const { orgId } = await params;
    if (!(await verifyOrgAccess(orgId, "org.settings"))) return apiError.forbidden();

    const row = await db.query.cronStatusPages.findFirst({ where: eq(cronStatusPages.organizationId, orgId) });
    return NextResponse.json(await serialize(row));
  } catch (error) {
    return handleRouteError(error, "Error reading the cron status page");
  }
}

// PATCH /api/v1/organizations/[orgId]/cron/status-page
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;
    const { orgId } = await params;
    if (!(await verifyOrgAccess(orgId, "org.settings"))) return apiError.forbidden();

    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);
    const { enabled, rotate } = parsed.data;
    const hostname = parsed.data.hostname === undefined ? undefined : parsed.data.hostname || null;

    const existing = await db.query.cronStatusPages.findFirst({ where: eq(cronStatusPages.organizationId, orgId) });

    if (hostname !== undefined && hostname !== (existing?.hostname ?? null)) {
      // It writes a Traefik route and asks for a certificate.
      if (!(await isAppAdmin())) {
        return NextResponse.json({ error: "Only an instance admin can set the hostname." }, { status: 403 });
      }
      if (hostname) {
        const conflict = await hostnameConflict(hostname, orgId);
        if (conflict) return NextResponse.json({ error: conflict }, { status: 409 });
      }
    }

    const set = {
      ...(enabled !== undefined && { enabled }),
      ...(hostname !== undefined && { hostname }),
      ...(rotate && { token: newStatusToken() }),
      updatedAt: new Date(),
    };
    const [row] = existing
      ? await db.update(cronStatusPages).set(set).where(eq(cronStatusPages.organizationId, orgId)).returning()
      : await db
          .insert(cronStatusPages)
          .values({ organizationId: orgId, token: newStatusToken(), enabled: enabled ?? false, hostname: hostname ?? null })
          .returning();

    let routed = true;
    try {
      await syncStatusRoutes();
    } catch (err) {
      routed = false;
      log.error("Writing the cron status routes failed:", err);
    }

    return NextResponse.json({ ...(await serialize(row)), routed });
  } catch (error) {
    if (isUniqueViolation(error)) return NextResponse.json({ error: "That hostname is taken" }, { status: 409 });
    return handleRouteError(error, "Error saving the cron status page");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/cron/status-page" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "org-cron-status-page" });
