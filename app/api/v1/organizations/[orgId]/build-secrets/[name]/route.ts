import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { buildSecretName, buildSecretValue, deleteBuildSecret, setBuildSecret } from "@/lib/build-secrets/store";

type RouteParams = { params: Promise<{ orgId: string; name: string }> };

const putSchema = z.object({ value: buildSecretValue }).strict();

// PUT — set a build secret; the response carries its name, never the value
async function handlePut(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, name } = await params;
    const org = await verifyOrgAccess(orgId, "org.buildSecrets.manage");
    if (!org) return apiError.forbidden();

    const parsedName = buildSecretName.safeParse(name);
    if (!parsedName.success) return apiError.validation(parsedName.error);
    const parsed = putSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);

    const buildSecret = await setBuildSecret(orgId, parsedName.data, parsed.data.value, org.session.user.id);
    return NextResponse.json({ buildSecret });
  } catch (error) {
    return handleRouteError(error);
  }
}

// DELETE — remove a build secret; a deploy falls back to the GitHub App token for npm_token
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, name } = await params;
    const org = await verifyOrgAccess(orgId, "org.buildSecrets.manage");
    if (!org) return apiError.forbidden();

    if (!(await deleteBuildSecret(orgId, name, org.session.user.id))) return apiError.notFound("build secret");
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "organizations-build-secrets" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-build-secrets" });
