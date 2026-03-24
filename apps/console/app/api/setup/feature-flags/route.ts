import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getFeatureFlagsConfig, setSystemSetting } from "@/lib/system-settings";
import {
  type FeatureFlag,
  getFlagConfig,
  isFeatureEnabledAsync,
} from "@/lib/config/features";

/** Flags exposed in the admin UI (skip "ui" — it's a hard kill switch). */
const ADMIN_FLAGS: FeatureFlag[] = [
  "terminal",
  "environments",
  "backups",
  "cron",
  "mesh",
];

/** Only accept known feature flag keys (excluding "ui" kill switch). */
const flagsSchema = z.object({
  terminal: z.boolean().optional(),
  environments: z.boolean().optional(),
  backups: z.boolean().optional(),
  cron: z.boolean().optional(),
  mesh: z.boolean().optional(),
}).strict();

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const flags = await Promise.all(
    ADMIN_FLAGS.map(async (flag) => {
      const config = getFlagConfig(flag);
      const enabled = await isFeatureEnabledAsync(flag);

      return {
        flag,
        label: config.label,
        description: config.description,
        enabled,
      };
    }),
  );

  return NextResponse.json({ configured: true, flags });
}

export async function POST(request: NextRequest) {
  await requireAdminAuth(request);

  const body = await request.json();
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

  return NextResponse.json({ ok: true });
}
