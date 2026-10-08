import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { orgDomains } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { runCheck, type Target } from "@/lib/domains/verify";

type RouteParams = { params: Promise<{ orgId: string }> };

const checkSchema = z.union([
  z.object({ id: z.string().min(1) }).strict(),
  z.object({ baseDomain: z.literal(true) }).strict(),
]);

// POST /api/v1/organizations/[orgId]/domains/verify
// Checks the TXT challenge for an org domain or, with { baseDomain: true }, the org's base domain.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.domains.manage");
    if (!org) return apiError.forbidden();

    const parsed = checkSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);

    let target: Target;
    if ("id" in parsed.data) {
      const row = await db.query.orgDomains.findFirst({
        where: and(eq(orgDomains.id, parsed.data.id), eq(orgDomains.organizationId, orgId)),
        columns: { id: true, isDefault: true },
      });
      if (!row || row.isDefault) return apiError.notFound("domain");
      target = { kind: "org-domain", id: row.id };
    } else {
      target = { kind: "org-base", id: orgId };
    }

    const outcome = await runCheck(target, { revoke: true });
    if (!outcome) return apiError.notFound("domain");
    return NextResponse.json({
      verified: outcome.verifiedAt !== null,
      lookupFailed: outcome.result.status === "error",
      recordName: outcome.recordName,
      recordValue: outcome.recordValue,
      found: outcome.result.status === "missing" ? outcome.result.found : [],
    });
  } catch (error) {
    return handleRouteError(error, "Error checking domain");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-domains-verify" });
