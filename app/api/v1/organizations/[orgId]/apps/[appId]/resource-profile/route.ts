import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { db } from "@/lib/db";
import { appMemoryAutotune, apps } from "@/lib/db/schema";
import { detectHost, loadResourceSettings, tierMemoryMb } from "@/lib/resources/host";
import { describeMemory } from "@/lib/resources/profile";
import { learnedStatus } from "@/lib/resources/learned";
import { learnedSummary } from "@/lib/ui/resource-formulas";
import { getOrgTimeZone } from "@/lib/time-zone-settings";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/resource-profile
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { memoryLimit: true, memoryProfile: true, memoryReservation: true, priority: true, containerMemoryLimit: true, status: true },
    });
    if (!app) return apiError.notFound("app");

    const [state, timeZone] = await Promise.all([
      db.query.appMemoryAutotune.findFirst({ where: eq(appMemoryAutotune.appId, appId) }),
      getOrgTimeZone(orgId),
      detectHost(),
      loadResourceSettings(),
    ]);
    const tier = app.priority ?? "standard";
    const status = learnedStatus(state?.dailyPeaks ?? [], tierMemoryMb(tier), Date.now());
    const explicit = app.memoryLimit !== null;
    const running = app.status === "active" && app.containerMemoryLimit ? Math.round(app.containerMemoryLimit / 1024 / 1024) : null;
    const memory = describeMemory({
      appProfile: app.memoryProfile,
      orgProfile: org.organization.memoryProfile,
      appLimitMb: app.memoryLimit,
      reservationMb: app.memoryReservation,
      tierDefaultMb: tierMemoryMb(tier),
      tier,
      learned: explicit ? null : status.learned,
      containerLimitBytes: app.status === "active" ? app.containerMemoryLimit : null,
      autotune: state ?? null,
      formatDate: (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone }),
    });
    const learned = { mb: status.learned?.mb ?? null, summary: learnedSummary(status, { explicit, runningMb: running }) };
    return NextResponse.json({ memory, learned, cpu: { profile: "fixed" } });
  } catch (error) {
    return handleRouteError(error, "Error reading the resource profile");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/resource-profile" });
