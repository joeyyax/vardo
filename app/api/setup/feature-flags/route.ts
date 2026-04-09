import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getFeatureFlagsConfig, setSystemSetting, invalidateSettingsCache } from "@/lib/system-settings";
import { getAllFeatureFlags, invalidateFlagCache, type FeatureFlag } from "@/lib/config/features";
import { provisionForFlag } from "@/lib/infra/provision";

import { withRateLimit } from "@/lib/api/with-rate-limit";

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const allFlags = await getAllFeatureFlags();
  // Exclude "ui" — it's a hard kill switch, not a user-facing toggle
  const flags = allFlags.filter((f) => f.flag !== "ui");

  return NextResponse.json({ configured: true, flags });
}

async function handlePost(request: NextRequest) {
  await requireAdminAuth(request);

  const body = await request.json();

  // Validate: only boolean values, only known flag keys
  const flagsSchema = z.record(z.string(), z.boolean());
  const parsed = flagsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  // Merge with existing DB flags (preserve any not sent in this request)
  const existing = (await getFeatureFlagsConfig()) ?? {};
  const merged = { ...existing, ...parsed.data };

  await setSystemSetting("feature_flags", JSON.stringify(merged));

  // Bust all caches so the new flags take effect immediately
  invalidateSettingsCache("feature_flags");
  await invalidateFlagCache();
  revalidatePath("/", "layout");

  // Provision or stop infrastructure services based on flag changes
  for (const [flag, enabled] of Object.entries(parsed.data)) {
    if (existing[flag] !== enabled) {
      provisionForFlag(flag as FeatureFlag, enabled).catch(() => {
        // Provisioning is best-effort — don't block the response
      });
    }
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-feature-flags" });
