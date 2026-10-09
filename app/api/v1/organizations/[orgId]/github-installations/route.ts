import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { githubAppInstallations } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { recordActivity } from "@/lib/activity";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import {
  linkInstallationToOrg,
  orgInstallations,
  unlinkInstallationFromOrg,
} from "@/lib/git-integration/org-installations";

const bodySchema = z.object({ installationId: z.number().int().positive() }).strict();

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/github-installations
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    return NextResponse.json({ installations: await orgInstallations(orgId) });
  } catch (error) {
    return handleRouteError(error, "Error fetching linked GitHub installations");
  }
}

// POST /api/v1/organizations/[orgId]/github-installations: an org admin links an installation they connected.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.settings");
    if (!org) return apiError.forbidden();

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "installationId is required" }, { status: 400 });
    }
    const { installationId } = parsed.data;

    const owned = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.userId, org.session.user.id),
        eq(githubAppInstallations.installationId, installationId),
      ),
      columns: { accountLogin: true },
    });
    if (!owned) return apiError.notFound("installation");

    await linkInstallationToOrg(orgId, installationId, org.session.user.id);

    recordActivity({
      organizationId: orgId,
      action: "github_installation.linked",
      userId: org.session.user.id,
      metadata: { installationId, accountLogin: owned.accountLogin },
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error linking GitHub installation");
  }
}

// DELETE /api/v1/organizations/[orgId]/github-installations
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.settings");
    if (!org) return apiError.forbidden();

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "installationId is required" }, { status: 400 });
    }

    await unlinkInstallationFromOrg(orgId, parsed.data.installationId);

    recordActivity({
      organizationId: orgId,
      action: "github_installation.unlinked",
      userId: org.session.user.id,
      metadata: { installationId: parsed.data.installationId },
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error unlinking GitHub installation");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/github-installations" });
export const POST = withRateLimit(handlePost, { tier: "mutation", key: "github-installations-link" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "github-installations-link" });
