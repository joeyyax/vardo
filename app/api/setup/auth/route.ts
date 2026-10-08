import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { getAuthConfig, setSystemSetting } from "@/lib/system-settings";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError } from "@/lib/api/error-response";

const authSchema = z.object({
  registrationMode: z.enum(["closed", "open", "approval"]),
  sessionDurationDays: z.number().int().min(1).max(365),
}).strict();

async function handleGet(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  await requireAdminAuth(request);

  const config = await getAuthConfig();

  return NextResponse.json({
    configured: true,
    registrationMode: config.registrationMode,
    sessionDurationDays: config.sessionDurationDays,
  });
}

async function handlePost(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  const setup = await needsSetup();
  if (!setup) {
    await requireAdminAuth(request);
  }

  const body = await request.json();
  const parsed = authSchema.safeParse(body);
  if (!parsed.success) {
    return apiError.validation(parsed.error, { details: true });
  }

  await setSystemSetting("auth_config", JSON.stringify(parsed.data));

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-auth" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:setup/auth" });
