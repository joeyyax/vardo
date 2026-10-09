import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { verifyAppAccess, verifyOrgAccess } from "@/lib/api/verify-access";
import { recordActivity } from "@/lib/activity";
import { encrypt, decryptOrFallback } from "@/lib/crypto/encrypt";
import { refuseSystemManaged } from "@/lib/api/system-managed";
import { maskEnvContent as mask, restoreMaskedEnv } from "@/lib/env/mask-env";
import { can } from "@/lib/auth/permissions";
import { loadEnvironmentEnv, saveEnvironmentEnv } from "@/lib/docker/environment-env";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

/** The non-default environment a request names: null for the app's own env, false when it isn't this app's. */
async function targetEnvironment(appId: string, environmentId: string | null | undefined) {
  if (!environmentId) return null;
  const env = await db.query.environments.findFirst({
    where: and(eq(environments.id, environmentId), eq(environments.appId, appId)),
    columns: { id: true, isDefault: true },
  });
  if (!env) return false;
  return env.isDefault ? null : env;
}

/** The plaintext env a masked save is restored from: the environment's own, else the app's. */
async function storedEnv(appId: string, orgId: string, env: { id: string } | null): Promise<string> {
  const own = env ? await loadEnvironmentEnv(env.id) : null;
  if (own !== null) return decryptOrFallback(own, orgId).content;
  const record = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: { envContent: true },
  });
  return record?.envContent ? decryptOrFallback(record.envContent, orgId).content : "";
}

const DECRYPT_ERROR = "Couldn't decrypt env vars — check ENCRYPTION_MASTER_KEY";

// GET /api/v1/organizations/[orgId]/apps/[appId]/env-vars[?environmentId=]
// Returns masked env content, or plaintext with `reveal=true` for env.reveal holders. `inherited` marks an environment with no env of its own.
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "env.read");
    const app = org && (await verifyAppAccess(orgId, appId, "env.read"));
    if (!org || !app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "env-vars");
    if (refused) return refused;

    const reveal = request.nextUrl.searchParams.get("reveal") === "true";
    if (reveal && !can(org.membership, "env.reveal")) return apiError.forbidden();

    const env = await targetEnvironment(appId, request.nextUrl.searchParams.get("environmentId"));
    if (env === false) {
      return NextResponse.json({ error: "Environment not found" }, { status: 404 });
    }

    if (reveal) {
      recordActivity({
        organizationId: orgId,
        action: "app.env_revealed",
        appId,
        userId: org.session.user.id,
        metadata: env ? { environmentId: env.id } : undefined,
      }).catch(() => {});
    }
    const own = env ? await loadEnvironmentEnv(env.id) : null;
    if (own !== null) {
      const { content, decryptFailed } = decryptOrFallback(own, orgId);
      if (decryptFailed) return NextResponse.json({ content: "", error: DECRYPT_ERROR });
      return NextResponse.json({ content: reveal ? content : mask(content) });
    }
    const inherited = env ? { inherited: true } : {};

    const record = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { envContent: true },
    });

    if (!record?.envContent) {
      return NextResponse.json({ content: "", ...inherited });
    }

    const { content: decrypted, wasEncrypted } = decryptOrFallback(record.envContent, orgId);

    if (!decrypted && !wasEncrypted) {
      return NextResponse.json({ content: "", error: DECRYPT_ERROR });
    }

    // If data was plaintext (unmigrated), encrypt it on read
    if (!wasEncrypted && decrypted) {
      const encrypted = encrypt(decrypted, orgId);
      await db.update(apps).set({ envContent: encrypted }).where(eq(apps.id, appId));
    }

    return NextResponse.json({ content: reveal ? decrypted : mask(decrypted), ...inherited });
  } catch (error) {
    return handleRouteError(error, "Error fetching env vars");
  }
}

const putSchema = z.object({
  content: z.string(),
  environmentId: z.string().optional(),
}).strict();

// PUT /api/v1/organizations/[orgId]/apps/[appId]/env-vars
// Saves the whole env file, encrypted.
async function handlePut(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "env.write");
    if (!app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "env-vars");
    if (refused) return refused;

    const body = await request.json();
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const env = await targetEnvironment(appId, parsed.data.environmentId);
    if (env === false) {
      return NextResponse.json({ error: "Environment not found" }, { status: 404 });
    }

    const content = restoreMaskedEnv(parsed.data.content, await storedEnv(appId, orgId, env));
    if (env) {
      await saveEnvironmentEnv(env.id, encrypt(content, orgId));
      return NextResponse.json({ saved: true });
    }

    const encrypted = content.trim() ? encrypt(content, orgId) : null;

    await db
      .update(apps)
      .set({
        envContent: encrypted,
        needsRedeploy: true,
        updatedAt: new Date(),
      })
      .where(and(eq(apps.id, appId), eq(apps.organizationId, orgId)));

    return NextResponse.json({ saved: true });
  } catch (error) {
    return handleRouteError(error, "Error saving env vars");
  }
}

export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "apps-env-vars" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/env-vars" });
