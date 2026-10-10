import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { splitGitUrl } from "@/lib/api/git-fields";
import { getGitHubAppConfig } from "@/lib/system-settings";
import { getPollIntervalMinutes } from "@/lib/git-integration/poll";
import { relaySourceCount } from "@/lib/mesh/webhook-relay-receive";
import { withRateLimit } from "@/lib/api/with-rate-limit";

/** GET .../apps/[appId]/auto-deploy — which triggers can deploy this app on a push, and the last poll */
async function handler(_request: NextRequest, { params }: { params: Promise<{ orgId: string; appId: string }> }) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { autoDeploy: true, source: true, gitUrl: true, gitPolledAt: true, gitPollError: true },
    });
    if (!app) return apiError.notFound("app");

    const onGithub = !!app.gitUrl && splitGitUrl(app.gitUrl).url.startsWith("https://github.com/");
    const [github, relaySources, pollIntervalMinutes] = await Promise.all([
      onGithub ? getGitHubAppConfig().catch(() => null) : Promise.resolve(null),
      onGithub ? relaySourceCount(orgId).catch(() => 0) : Promise.resolve(0),
      getPollIntervalMinutes(),
    ]);

    return NextResponse.json({
      autoDeploy: !!app.autoDeploy,
      git: app.source === "git" && !!app.gitUrl,
      webhook: !!github?.webhookSecret,
      relaySources,
      poll: {
        intervalMinutes: pollIntervalMinutes,
        checkedAt: app.gitPolledAt?.toISOString() ?? null,
        error: app.gitPollError,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error reading auto-deploy triggers");
  }
}

export const GET = withRateLimit(handler, { tier: "read", key: "get:v1/apps/auto-deploy" });
