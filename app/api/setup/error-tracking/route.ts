import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getErrorTrackingConfig, setSystemSetting, invalidateSettingsCache } from "@/lib/system-settings";
import { maskSecret, resolveSecret } from "@/lib/mask-secrets";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const errorTrackingSchema = z.object({
  apiToken: z.string().optional(),
  url: z.string().url().optional().or(z.literal("")),
  publicUrl: z.string().url().optional().or(z.literal("")),
}).strict();

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getErrorTrackingConfig();
  if (!config) {
    return NextResponse.json({ configured: false });
  }

  return NextResponse.json({
    configured: true,
    apiToken: maskSecret(config.apiToken),
    url: config.url ?? null,
    publicUrl: config.publicUrl ?? null,
  });
}

async function handlePost(request: NextRequest) {
  await requireAdminAuth(request);

  const body = await request.json();
  const parsed = errorTrackingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const existing = await getErrorTrackingConfig();

  await setSystemSetting("error_tracking", JSON.stringify({
    apiToken: resolveSecret(parsed.data.apiToken, existing?.apiToken),
    url: parsed.data.url || undefined,
    publicUrl: parsed.data.publicUrl || undefined,
  }));
  invalidateSettingsCache("error_tracking");

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-error-tracking" });
