import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { emailSettingsSchema, readEmailSettings, saveEmailSettings } from "@/lib/email/provider-settings";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError } from "@/lib/api/error-response";

async function handleGet(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  await requireAdminAuth(request);

  return NextResponse.json(await readEmailSettings());
}

async function handlePost(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  const setup = await needsSetup();
  if (!setup) {
    await requireAdminAuth(request);
  }

  const body = await request.json();
  const parsed = emailSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError.validation(parsed.error, { details: true });
  }

  const error = await saveEmailSettings(parsed.data);
  if (error) return NextResponse.json({ error }, { status: 403 });

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-email" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:setup/email" });
