import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api/error-response";
import { refuseSystemManaged } from "@/lib/api/system-managed";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { recordActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { setParked } from "@/lib/db/app-parked";
import { apps } from "@/lib/db/schema";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const parkSchema = z.object({ parked: z.boolean() }).strict();

async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.deploy");
    if (!org) return apiError.forbidden();

    const parsed = parkSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, parentAppId: true, isSystemManaged: true },
    });
    if (!app) return apiError.notFound("app");

    const refused = refuseSystemManaged(app, "park");
    if (refused) return refused;

    // A service can't park itself; the parent owns the stack.
    if (app.parentAppId) {
      return NextResponse.json(
        { error: "This service is part of a compose stack. Park the stack instead." },
        { status: 400 },
      );
    }

    await setParked(app.id, parsed.data.parked);

    recordActivity({
      organizationId: orgId,
      action: parsed.data.parked ? "app.parked" : "app.unparked",
      appId,
      userId: org.session.user.id,
    });

    return NextResponse.json({ parked: parsed.data.parked });
  } catch (error) {
    return handleRouteError(error, "Error parking app");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-apps" });
