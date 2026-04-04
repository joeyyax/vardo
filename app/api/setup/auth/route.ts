import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { getAuthConfig, setSystemSetting } from "@/lib/system-settings";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const authSchema = z.object({
  registrationMode: z.enum(["closed", "open", "approval"]),
  sessionDurationDays: z.number().int().min(1).max(365),
}).strict();

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getAuthConfig();

  return NextResponse.json({
    configured: true,
    registrationMode: config.registrationMode,
    sessionDurationDays: config.sessionDurationDays,
  });
}

async function handlePost(request: NextRequest) {
  const setup = await needsSetup();
  if (!setup) {
    await requireAdminAuth(request);
  }

  const body = await request.json();
  const parsed = authSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  await setSystemSetting("auth_config", JSON.stringify(parsed.data));

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-auth" });
