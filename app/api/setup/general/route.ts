import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { getInstanceConfig, setSystemSetting } from "@/lib/system-settings";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError } from "@/lib/api/error-response";

const generalSchema = z.object({
  instanceName: z.string().min(1).max(100),
  baseDomain: z.string().optional(),
  serverIp: z.string().optional(),
  domain: z.string().optional(),
}).strict();

async function handleGet(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  await requireAdminAuth(request);

  const config = await getInstanceConfig();

  return NextResponse.json({
    configured: true,
    instanceName: config.instanceName,
    baseDomain: config.baseDomain,
    serverIp: config.serverIp,
    domain: config.domain,
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
  const parsed = generalSchema.safeParse(body);
  if (!parsed.success) {
    return apiError.validation(parsed.error, { details: true });
  }

  const existing = await getInstanceConfig();

  await setSystemSetting("instance_config", JSON.stringify({
    instanceName: parsed.data.instanceName,
    baseDomain: parsed.data.baseDomain ?? existing.baseDomain,
    serverIp: parsed.data.serverIp ?? existing.serverIp,
    domain: parsed.data.domain ?? existing.domain,
  }));

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-general" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:setup/general" });
