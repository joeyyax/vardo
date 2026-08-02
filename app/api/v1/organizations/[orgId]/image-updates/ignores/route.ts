import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps, imageUpdateIgnores } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { expiryFor } from "@/lib/docker/image-updates/ignore";
import { readIgnoreRules } from "@/lib/docker/image-updates/read-ignores";

type RouteParams = { params: Promise<{ orgId: string }> };

const ruleSchema = z
  .object({
    appId: z.string().min(1).max(64),
    /** Compose service the rule covers. Omit for a single-image app. */
    service: z.string().min(1).max(255).nullish(),
    scope: z.enum(["all", "major"]).default("all"),
    /** Days until the rule lapses. Null never lapses. */
    days: z.number().int().positive().max(3650).nullable().default(null),
  })
  .strict();

const deleteSchema = z
  .object({
    appId: z.string().min(1).max(64),
    service: z.string().min(1).max(255).nullish(),
  })
  .strict();

// GET — every rule in the org. Lapsed ones are included; expiry is read, not swept.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const gate = await requirePlugin("image-updates");
    if (gate) return gate;
    return NextResponse.json({ rules: await readIgnoreRules(orgId) });
  } catch (error) {
    return handleRouteError(error, "Error reading ignore rules");
  }
}

// POST — ignore one app or one compose service. Replaces any existing rule for it.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const gate = await requirePlugin("image-updates");
    if (gate) return gate;

    const parsed = ruleSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { appId, scope, days } = parsed.data;
    const service = parsed.data.service ?? null;

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });
    if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const expiresAt = expiryFor(days);
    const [rule] = await db
      .insert(imageUpdateIgnores)
      .values({
        id: nanoid(),
        organizationId: orgId,
        appId,
        composeService: service,
        scope,
        expiresAt,
        createdBy: org.session.user.id,
      })
      .onConflictDoUpdate({
        target: [imageUpdateIgnores.appId, imageUpdateIgnores.composeService],
        set: { scope, expiresAt, createdBy: org.session.user.id, createdAt: new Date() },
      })
      .returning();

    await recordActivity({
      organizationId: orgId,
      action: "app.image_update_ignored",
      appId,
      userId: org.session.user.id,
      metadata: { service, scope, expiresAt: expiresAt?.toISOString() ?? null },
    }).catch(() => {});

    return NextResponse.json({
      rule: {
        id: rule.id,
        appId: rule.appId,
        composeService: rule.composeService,
        scope: rule.scope,
        expiresAt: rule.expiresAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error saving ignore rule");
  }
}

// DELETE — stop ignoring, so the update surfaces on the next read.
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const gate = await requirePlugin("image-updates");
    if (gate) return gate;

    const parsed = deleteSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const service = parsed.data.service ?? null;

    const removed = await db
      .delete(imageUpdateIgnores)
      .where(
        and(
          eq(imageUpdateIgnores.organizationId, orgId),
          eq(imageUpdateIgnores.appId, parsed.data.appId),
          service === null
            ? isNull(imageUpdateIgnores.composeService)
            : eq(imageUpdateIgnores.composeService, service),
        ),
      )
      .returning({ id: imageUpdateIgnores.id });

    if (removed.length === 0) {
      return NextResponse.json({ error: "No such ignore rule" }, { status: 404 });
    }

    await recordActivity({
      organizationId: orgId,
      action: "app.image_update_unignored",
      appId: parsed.data.appId,
      userId: org.session.user.id,
      metadata: { service },
    }).catch(() => {});

    return NextResponse.json({ removed: removed.length });
  } catch (error) {
    return handleRouteError(error, "Error removing ignore rule");
  }
}

export const GET = handleGet;
export const POST = withRateLimit(handlePost, { tier: "mutation", key: "image-update-ignores" });
export const DELETE = withRateLimit(handleDelete, {
  tier: "mutation",
  key: "image-update-ignores",
});
