import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyAppAccess } from "@/lib/api/verify-access";
import {
  addDomain,
  createDomainSchema,
  editDomain,
  removeDomain,
  updateDomainSchema,
  type DomainSubject,
} from "@/lib/domains/manage";
import { domainResponse } from "@/lib/domains/domain-response";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

/** The app under its organization, or null when it isn't there. */
async function subject(orgId: string, appId: string): Promise<DomainSubject | null> {
  const app = await verifyAppAccess(orgId, appId, "app.domains");
  return app ? { id: app.id, organizationId: orgId, isSystemManaged: app.isSystemManaged } : null;
}

// POST /api/v1/organizations/[orgId]/apps/[appId]/domains
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await subject(orgId, appId);
    if (!app) return apiError.notFound("app");

    const parsed = createDomainSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);

    return domainResponse(await addDomain(app, parsed.data), 201);
  } catch (error) {
    return handleRouteError(error, "Error creating domain");
  }
}

// PATCH /api/v1/organizations/[orgId]/apps/[appId]/domains
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await subject(orgId, appId);
    if (!app) return apiError.notFound("app");

    const parsed = updateDomainSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);

    return domainResponse(await editDomain(app, parsed.data));
  } catch (error) {
    return handleRouteError(error, "Error updating domain");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/domains
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await subject(orgId, appId);
    if (!app) return apiError.notFound("app");

    const parsed = z.object({ id: z.string().min(1) }).strict().safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);

    return domainResponse(await removeDomain(app, parsed.data.id));
  } catch (error) {
    return handleRouteError(error, "Error deleting domain");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-domains" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "apps-domains" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-domains" });
