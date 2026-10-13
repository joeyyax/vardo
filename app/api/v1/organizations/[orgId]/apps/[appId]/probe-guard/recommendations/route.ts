import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps, probeRecommendations } from "@/lib/db/schema";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { recordActivity } from "@/lib/activity";
import { appProbeGuardSchema, normalizeAppProbeGuard } from "@/lib/probe-guard/settings";
import { applyTemplate } from "@/lib/probe-guard/templates/apply";
import { findTemplate } from "@/lib/probe-guard/templates";
import { listRecommendations, resolveRecommendation } from "@/lib/probe-guard/recommendations";
import { answerSuggestion, pendingSuggestion } from "@/lib/probe-guard/suggestions";
import { syncGuardFile } from "@/lib/probe-guard/sync";

type RouteParams = { params: Promise<{ orgId: string; appId: string }> };

const bodySchema = z
  .object({
    action: z.enum(["apply", "ignore", "restore"]),
    templateIds: z.array(z.string().min(1).max(64)).min(1).max(20),
    /** The wordpress-probes suggestion id handled in this same request. */
    suggestionId: z.enum(["wordpress-probes"]).optional(),
    suggestionBlock: z.boolean().optional(),
  })
  .strict();

async function readGuard(appId: string, orgId: string) {
  const row = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: { probeGuard: true, parentAppId: true },
  });
  return row;
}

/** Apply templates, ignore/restore them, and answer the wordpress suggestion. All in one call. */
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.config");
    if (!org) return apiError.forbidden();
    const row = await readGuard(appId, orgId);
    if (!row) return apiError.notFound("app");
    if (row.parentAppId) {
      return NextResponse.json({ error: "Set this on the compose app, not a service." }, { status: 400 });
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    const { action, templateIds, suggestionId, suggestionBlock } = parsed.data;

    for (const id of templateIds) {
      if (!findTemplate(id)) {
        return NextResponse.json({ error: `unknown template: ${id}` }, { status: 400 });
      }
    }

    const settings = normalizeAppProbeGuard(row.probeGuard);
    const validated = appProbeGuardSchema.safeParse(settings);
    if (!validated.success) {
      return NextResponse.json({ error: "Stored guard is invalid; re-save it from Settings." }, { status: 500 });
    }
    let next = validated.data;

    if (suggestionId === "wordpress-probes") {
      const current = pendingSuggestion(next, false);
      if (!current) {
        return NextResponse.json({ error: "No WordPress question to answer." }, { status: 409 });
      }
      if (typeof suggestionBlock !== "boolean") {
        return NextResponse.json({ error: "Answer the WordPress question with true or false." }, { status: 400 });
      }
      next = answerSuggestion(next, current, suggestionBlock);
    }

    if (action === "apply") {
      for (const id of templateIds) {
        const template = findTemplate(id);
        if (!template) continue;
        next = applyTemplate(next, template);
      }
    }

    const stored = appProbeGuardSchema.safeParse(next);
    if (!stored.success) {
      return NextResponse.json({ error: "The change would make the guard invalid." }, { status: 400 });
    }
    await db.update(apps).set({ probeGuard: stored.data, updatedAt: new Date() }).where(eq(apps.id, appId));
    const applied = await syncGuardFile().catch(() => "skipped" as const);

    if (action === "apply") {
      await Promise.all(templateIds.map((id) => resolveRecommendation(appId, id, "applied")));
    } else if (action === "ignore") {
      await Promise.all(templateIds.map((id) => resolveRecommendation(appId, id, "ignored")));
    } else if (action === "restore") {
      // restore reopens an ignored recommendation without bumping the template version
      await Promise.all(
        templateIds.map((id) => {
          const template = findTemplate(id);
          if (!template) return Promise.resolve();
          return db
            .update(probeRecommendations)
            .set({ status: "pending", templateVersion: template.version, updated: false, updatedAt: new Date() })
            .where(and(eq(probeRecommendations.appId, appId), eq(probeRecommendations.templateId, id)));
        }),
      );
    }

    const recommendations = await listRecommendations(appId);
    recordActivity({
      organizationId: orgId,
      action: "app.updated",
      appId,
      userId: org.session.user.id,
      metadata: { changes: ["probeGuard"], recommendations: { action, templateIds, suggestionId } },
    }).catch(() => {});

    return NextResponse.json({ settings: stored.data, recommendations, applied: applied === "skipped" ? "pending" : "live" });
  } catch (error) {
    return handleRouteError(error, "Error saving recommendations");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "post:v1/organizations/*/apps/*/probe-guard/recommendations" });