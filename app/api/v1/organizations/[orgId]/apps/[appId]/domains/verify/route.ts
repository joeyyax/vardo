import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { verifyAppAccess, verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { loadInstanceHosts, loadVerifiedZones } from "@/lib/domains/context";
import { newChallengeToken, verificationView } from "@/lib/domains/ownership";
import { runCheck } from "@/lib/domains/verify";

type RouteParams = { params: Promise<{ orgId: string; appId: string }> };

// GET /api/v1/organizations/[orgId]/apps/[appId]/domains/verify
// Each domain's ownership state and the TXT record to add.
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const access = await verifyOrgAccess(orgId, "app.view");
    if (!access) return apiError.forbidden();
    const app = await verifyAppAccess(orgId, appId, "app.view");
    if (!app) return apiError.notFound("app");

    const [rows, inst, zones] = await Promise.all([
      db.select().from(domains).where(eq(domains.appId, appId)),
      loadInstanceHosts(),
      loadVerifiedZones(orgId),
    ]);
    // Rows created elsewhere (auto domains, adoption) have no token yet.
    for (const r of rows) {
      if (r.verificationToken) continue;
      const [set] = await db
        .update(domains)
        .set({ verificationToken: newChallengeToken() })
        .where(and(eq(domains.id, r.id), isNull(domains.verificationToken)))
        .returning({ token: domains.verificationToken });
      // A concurrent request set it first.
      r.verificationToken = set?.token
        ?? (await db.query.domains.findFirst({ where: eq(domains.id, r.id), columns: { verificationToken: true } }))?.verificationToken
        ?? null;
    }
    const trust = { trusted: access.organization.trusted };
    return NextResponse.json({
      verification: Object.fromEntries(rows.map((r) => [r.id, verificationView(r, inst, trust, zones)])),
    });
  } catch (error) {
    return handleRouteError(error, "Error loading domain verification");
  }
}

const checkSchema = z.object({ id: z.string().min(1) }).strict();

// POST /api/v1/organizations/[orgId]/apps/[appId]/domains/verify
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.domains");
    if (!app) return apiError.notFound("app");

    const parsed = checkSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);

    const row = await db.query.domains.findFirst({
      where: and(eq(domains.id, parsed.data.id), eq(domains.appId, appId)),
      columns: { id: true },
    });
    if (!row) return apiError.notFound("domain");

    const outcome = await runCheck({ kind: "app-domain", id: row.id }, { revoke: true });
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

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-domains-verify" });
