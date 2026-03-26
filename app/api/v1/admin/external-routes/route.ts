import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
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

const createExternalRouteSchema = z.object({
  hostname: hostnameSchema,
  targetUrl: z.string().url("Target must be a valid URL").optional().or(z.literal("")),
  tls: z.boolean().default(false),
  insecureSkipVerify: z.boolean().default(false),
  redirectUrl: z.string().url("Redirect URL must be a valid URL").nullable().optional(),
  redirectPermanent: z.boolean().default(false),
}).refine(
  (data) => data.redirectUrl || (data.targetUrl && data.targetUrl.length > 0),
  { message: "Either targetUrl or redirectUrl is required" }
);

/** GET /api/v1/admin/external-routes — list all external routes */
export async function GET() {
  try {
    await requireAppAdmin();

    const routes = await db.query.externalRoutes.findMany({
      orderBy: (t, { asc }) => asc(t.hostname),
    });

    return NextResponse.json({ routes });
  } catch (error) {
    return handleRouteError(error, "Error listing external routes");
  }
}

/** POST /api/v1/admin/external-routes — create a new external route */
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = createExternalRouteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { hostname, targetUrl, tls, insecureSkipVerify, redirectUrl, redirectPermanent } =
      parsed.data;

    const existingRoute = await db.query.externalRoutes.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.hostname, hostname),
    });
    if (existingRoute) {
      return NextResponse.json(
        { error: "A route for this hostname already exists" },
        { status: 409 }
      );
    }

    const existingDomain = await db.query.domains.findFirst({
      where: eq(domains.domain, hostname),
    });
    if (existingDomain) {
      return NextResponse.json(
        { error: "This hostname is already managed as a domain" },
        { status: 409 }
      );
    }

    const [route] = await db
      .insert(externalRoutes)
      .values({
        id: nanoid(),
        hostname,
        targetUrl: targetUrl || null,
        tls,
        insecureSkipVerify,
        redirectUrl: redirectUrl ?? null,
        redirectPermanent,
      })
      .returning();

    await regenerateExternalRoutesConfig();

    return NextResponse.json({ route }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating external route");
  }
}
