import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getFeatureFlagLayers, setSystemSetting, invalidateSettingsCache } from "@/lib/system-settings";
import {
  getAllFeatureFlags,
  getFlagConfig,
  invalidateFlagCache,
  resolveFeatureFlag,
  featureFlagEnvVar,
  featureFlagFromEnv,
  ALL_FEATURE_FLAGS,
  FLAG_GROUPS,
  type FeatureFlag,
} from "@/lib/config/features";
import { provisionForFlag } from "@/lib/infra/provision";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError } from "@/lib/api/error-response";

async function handleGet(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  await requireAdminAuth(request);

  const flags = await getAllFeatureFlags();

  return NextResponse.json({ configured: true, flags, groups: FLAG_GROUPS });
}

async function handlePost(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  await requireAdminAuth(request);

  const body = await request.json();

  // Booleans for declared flags only.
  const flagsSchema = z.record(z.string(), z.boolean());
  const parsed = flagsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError.validation(parsed.error, { details: true });
  }

  const known = new Set<string>(ALL_FEATURE_FLAGS);
  const unknown = Object.keys(parsed.data).filter((flag) => !known.has(flag));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown feature flag: ${unknown.join(", ")}` },
      { status: 400 },
    );
  }

  const layers = await getFeatureFlagLayers();

  // Refuse writes that wouldn't take effect: the dashboard kill switch is config-only
  // and env vars or vardo.yml outrank stored values.
  const pinned: string[] = [];
  for (const flag of Object.keys(parsed.data) as FeatureFlag[]) {
    if (getFlagConfig(flag).configOnly) {
      pinned.push(`${flag} (set it in vardo.yml or ${featureFlagEnvVar(flag)})`);
    } else if (featureFlagFromEnv(flag) !== undefined) {
      pinned.push(`${flag} (pinned by ${featureFlagEnvVar(flag)})`);
    } else if (flag in layers.config) {
      pinned.push(`${flag} (pinned by vardo.yml)`);
    }
  }
  if (pinned.length > 0) {
    return NextResponse.json(
      { error: `Can't change ${pinned.join(", ")}.`, pinned },
      { status: 409 },
    );
  }

  // Resolved values before the write, so provisioning only runs on real changes.
  const before = new Map<string, boolean>();
  for (const flag of Object.keys(parsed.data) as FeatureFlag[]) {
    before.set(flag, resolveFeatureFlag(flag, layers).enabled);
  }

  // Write against the DB layer only — never bake vardo.yml values into it.
  const merged: Record<string, boolean> = { ...layers.database, ...parsed.data };

  await setSystemSetting("feature_flags", JSON.stringify(merged));

  // Bust caches so the new flags take effect.
  invalidateSettingsCache("feature_flags");
  await invalidateFlagCache();
  revalidatePath("/", "layout");

  // Provision services for changed flags. A failed enable reverts that flag and returns why.
  const failed: string[] = [];
  const reasons: string[] = [];
  for (const [flag, enabled] of Object.entries(parsed.data)) {
    if (before.get(flag) === enabled) continue;
    try {
      await provisionForFlag(flag as FeatureFlag, enabled);
    } catch (err) {
      failed.push(flag);
      reasons.push(
        err instanceof Error && err.message ? err.message : `Couldn't provision ${flag}.`,
      );
      merged[flag] = before.get(flag) ?? false;
    }
  }

  if (failed.length > 0) {
    // Re-persist with the failed flags reverted to their prior state.
    await setSystemSetting("feature_flags", JSON.stringify(merged));
    invalidateSettingsCache("feature_flags");
    await invalidateFlagCache();
    revalidatePath("/", "layout");
    return NextResponse.json(
      { ok: false, failed, error: `${reasons.join(" ")} Reverted.` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-feature-flags" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:setup/feature-flags" });
