import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { applyImageUpdate } from "@/lib/docker/image-updates/apply-update";
import { summarizeBatch, type BatchItemResult } from "@/lib/docker/image-updates/batch-report";

type RouteParams = { params: Promise<{ orgId: string }> };

/** Cap per request. Callers page above it. */
const MAX_ITEMS = 100;

const batchSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            appId: z.string().min(1).max(64),
            service: z.string().min(1).max(255).nullish(),
            tag: z
              .string()
              .min(1)
              .max(128)
              .regex(/^[\w][\w.-]*$/, "Invalid tag"),
            acknowledgeMigration: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ITEMS),
  })
  .strict();

// POST — apply many pins in one call, reporting each one's outcome.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId, "app.deploy");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const gate = await requirePlugin("image-updates");
    if (gate) return gate;

    const parsed = batchSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    // Serial: parallel writes to one compose file lose all but the last.
    const results: BatchItemResult[] = [];
    for (const item of parsed.data.updates) {
      const outcome = await applyImageUpdate({
        orgId,
        appId: item.appId,
        userId: org.session.user.id,
        service: item.service,
        tag: item.tag,
        acknowledgeMigration: item.acknowledgeMigration,
      }).catch((error) => ({
        ok: false as const,
        appId: item.appId,
        appName: null,
        displayName: null,
        service: item.service ?? null,
        status: 500,
        error: error instanceof Error ? error.message : "Update failed",
      }));

      results.push({
        appId: outcome.appId,
        appName: outcome.appName,
        displayName: outcome.displayName,
        service: outcome.service,
        tag: item.tag,
        ok: outcome.ok,
        ...(outcome.ok ? {} : { error: outcome.error }),
      });
    }

    const report = summarizeBatch(results);
    // 207: partial success. The body says which.
    return NextResponse.json(report, { status: report.failed > 0 && report.applied > 0 ? 207 : 200 });
  } catch (error) {
    return handleRouteError(error, "Error applying image updates");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "image-updates-batch" });
