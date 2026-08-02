import { NextRequest, NextResponse } from "next/server";
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

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const flags = await getAllFeatureFlags();

  return NextResponse.json({ configured: true, flags, groups: FLAG_GROUPS });
}

async function handlePost(request: NextRequest) {
  await requireAdminAuth(request);

  const body = await request.json();

  // Validate: boolean values only, and only flags we actually declare
  const flagsSchema = z.record(z.string(), z.boolean());
  const parsed = flagsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
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

  // Refuse writes that wouldn't take effect: the dashboard kill switch is
  // config-only, and env vars or vardo.yml outrank whatever we'd store here.
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

  // Bust all caches so the new flags take effect immediately
  invalidateSettingsCache("feature_flags");
  await invalidateFlagCache();
  revalidatePath("/", "layout");

  // Provision infrastructure for changed flags. Enabling awaits the first
  // deploy and rolls back on failure (provisionForFlag throws), so a failed
  // integration never lingers as a connected-but-broken app (#741). On failure
  // we revert that flag so the UI doesn't show a disconnected integration as on.
  const failed: string[] = [];
  for (const [flag, enabled] of Object.entries(parsed.data)) {
    if (before.get(flag) === enabled) continue;
    try {
      await provisionForFlag(flag as FeatureFlag, enabled);
    } catch {
      failed.push(flag);
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
      { ok: false, failed, error: `Couldn't start ${failed.join(", ")} — deploy failed, reverted.` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-feature-flags" });
