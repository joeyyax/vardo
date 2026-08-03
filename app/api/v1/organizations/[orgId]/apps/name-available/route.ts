import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, organizations } from "@/lib/db/schema";
import { handleRouteError } from "@/lib/api/error-response";
import { isTopLevelAppNameTaken } from "@/lib/db/app-name";
import { getBaseDomain } from "@/lib/domain-monitoring/auto-domain";
import { isReservedSlug } from "@/lib/domain-monitoring/reserved";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

/**
 * GET /api/v1/organizations/[orgId]/apps/name-available?name=foo&generateDomain=true
 *
 * Answers the same question POST /apps enforces: is this slug free instance-wide,
 * and is the domain it would claim free too. Membership in the org is all the
 * caller needs — the response says nothing about who holds a taken name.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const searchParams = request.nextUrl.searchParams;
    const name = (searchParams.get("name") || "").trim();
    const wantsDomain = searchParams.get("generateDomain") !== "false";

    if (!/^[a-z0-9-]+$/.test(name)) {
      return NextResponse.json({ available: false, reason: "invalid" });
    }

    if (await isTopLevelAppNameTaken(name)) {
      return NextResponse.json({ available: false, reason: "taken" });
    }

    if (wantsDomain) {
      if (isReservedSlug(name)) {
        return NextResponse.json({ available: false, reason: "reserved" });
      }

      const orgRecord = await db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { baseDomain: true },
      });
      const domain = `${name}.${getBaseDomain(orgRecord?.baseDomain)}`;

      const taken = await db.query.domains.findFirst({
        where: eq(domains.domain, domain),
        columns: { id: true },
      });
      if (taken) {
        return NextResponse.json({ available: false, reason: "domain-taken", domain });
      }

      return NextResponse.json({ available: true, domain });
    }

    return NextResponse.json({ available: true });
  } catch (error) {
    return handleRouteError(error, "Error checking app name availability");
  }
}
