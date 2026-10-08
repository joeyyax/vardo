import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { join } from "path";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getTraefikConfig, setSystemSetting, invalidateSettingsCache } from "@/lib/system-settings";
import { writeEnvKey } from "@/lib/env/write-env-key";
import { logger } from "@/lib/logger";
import { VARDO_HOME_DIR } from "@/lib/paths";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError } from "@/lib/api/error-response";

const log = logger.child("admin:traefik");

const traefikConfigSchema = z.object({
  externalRouting: z.boolean(),
});

async function handleGet(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getTraefikConfig();
  return NextResponse.json(config);
}

async function handlePost(request: NextRequest) {
  await requireAdminAuth(request);

  const body = await request.json();
  const parsed = traefikConfigSchema.safeParse(body);
  if (!parsed.success) {
    return apiError.validation(parsed.error, { details: true });
  }

  await setSystemSetting("traefik_config", JSON.stringify(parsed.data));
  invalidateSettingsCache("traefik_config");

  // Writes TRAEFIK_DOCKER_NETWORK to the host .env for Traefik's next restart.
  // Empty means no network filter; "vardo-network" restricts routing to it.
  const envPath = join(VARDO_HOME_DIR, ".env");
  const networkValue = parsed.data.externalRouting ? "" : "vardo-network";

  try {
    await writeEnvKey(envPath, "TRAEFIK_DOCKER_NETWORK", networkValue);
  } catch (err) {
    log.error(`Failed to write ${envPath}: ${err}`);
    return NextResponse.json(
      { error: "Saved to database but couldn't update .env — check server permissions" },
      { status: 500 },
    );
  }

  log.info(`Traefik config updated: externalRouting=${parsed.data.externalRouting}`);

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-traefik" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/traefik" });
