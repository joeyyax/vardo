import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getFeatureFlagsConfig, setSystemSetting } from "@/lib/system-settings";
import { getAllFeatureFlags } from "@/lib/config/features";

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const allFlags = await getAllFeatureFlags();
  // Exclude "ui" — it's a hard kill switch, not a user-facing toggle
  const flags = allFlags.filter((f) => f.flag !== "ui");

  return NextResponse.json({ configured: true, flags });
}

export async function POST(request: NextRequest) {
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

  return NextResponse.json({ ok: true });
}
