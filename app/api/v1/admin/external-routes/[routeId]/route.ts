import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { externalRoutes, domains } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { regenerateExternalRoutesConfig } from "@/lib/traefik/generate-external-routes-config";

const hostnameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/, "Hostname must be a valid domain");

const updateExternalRouteSchema = z.object({
  hostname: hostnameSchema.optional(),
  targetUrl: z.string().url("Target must be a valid URL").optional().or(z.literal("")),
  tls: z.boolean().optional(),
  insecureSkipVerify: z.boolean().optional(),
  redirectUrl: z.string().url("Redirect URL must be a valid URL").nullable().optional(),
  redirectPermanent: z.boolean().optional(),
});

/** GET /api/v1/admin/external-routes/[routeId] — fetch a single external route */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ routeId: string }> }
) {
  try {
    await requireAppAdmin();

    const { routeId } = await params;

    const route = await db.query.externalRoutes.findFirst({
      where: eq(externalRoutes.id, routeId),
    });

    if (!route) {
      return NextResponse.json({ error: "Route not found" }, { status: 404 });
    }

    return NextResponse.json({ route });
  } catch (error) {
    return handleRouteError(error, "Error fetching external route");
  }
}

/** PATCH /api/v1/admin/external-routes/[routeId] — update an external route */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ routeId: string }> }
) {
  try {
    await requireAppAdmin();

    const { routeId } = await params;

    const existing = await db.query.externalRoutes.findFirst({
      where: eq(externalRoutes.id, routeId),
    });

    if (!existing) {
      return NextResponse.json({ error: "Route not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = updateExternalRouteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const updates = parsed.data;

    // Check hostname uniqueness if it's being changed
    if (updates.hostname && updates.hostname !== existing.hostname) {
      const conflictRoute = await db.query.externalRoutes.findFirst({
        where: (t, { eq: eqOp }) => eqOp(t.hostname, updates.hostname!),
      });
      if (conflictRoute) {
        return NextResponse.json(
          { error: "A route for this hostname already exists" },
          { status: 409 }
        );
      }

      const conflictDomain = await db.query.domains.findFirst({
        where: eq(domains.domain, updates.hostname),
      });
      if (conflictDomain) {
        return NextResponse.json(
          { error: "This hostname is already managed as a domain" },
          { status: 409 }
        );
      }
    }

    const [route] = await db
      .update(externalRoutes)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(externalRoutes.id, routeId))
      .returning();

    await regenerateExternalRoutesConfig();

    return NextResponse.json({ route });
  } catch (error) {
    return handleRouteError(error, "Error updating external route");
  }
}

/** DELETE /api/v1/admin/external-routes/[routeId] — delete an external route */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ routeId: string }> }
) {
  try {
    await requireAppAdmin();

    const { routeId } = await params;

    const existing = await db.query.externalRoutes.findFirst({
      where: eq(externalRoutes.id, routeId),
    });

    if (!existing) {
      return NextResponse.json({ error: "Route not found" }, { status: 404 });
    }

    await db.delete(externalRoutes).where(eq(externalRoutes.id, routeId));
    await regenerateExternalRoutesConfig();

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting external route");
  }
}
