import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { adoptCompose, adoptSchema } from "@/lib/docker/adopt";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// POST /api/v1/organizations/[orgId]/adopt
async function handler(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;

    const org = await verifyOrgAccess(orgId, "app.create");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const gate = await requirePlugin("container-import");
    if (gate) return gate;

    const parsed = adoptSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const result = await adoptCompose(parsed.data, { orgId, userId: org.session.user.id });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return handleRouteError(error, "Error adopting compose project");
  }
}

export const POST = withRateLimit(handler, {
  tier: "mutation",
  key: "adopt",
});
