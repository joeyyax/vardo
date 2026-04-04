import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { join } from "path";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getTraefikConfig, setSystemSetting, invalidateSettingsCache } from "@/lib/system-settings";
import { writeEnvKey } from "@/lib/env/write-env-key";
import { logger } from "@/lib/logger";
import { VARDO_HOME_DIR } from "@/lib/paths";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const log = logger.child("admin:traefik");

const traefikConfigSchema = z.object({
  externalRouting: z.boolean(),
});

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getTraefikConfig();
  return NextResponse.json(config);
}

async function handlePost(request: NextRequest) {
  await requireAdminAuth(request);

  const body = await request.json();
  const parsed = traefikConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  await setSystemSetting("traefik_config", JSON.stringify(parsed.data));
  invalidateSettingsCache("traefik_config");

  // Write TRAEFIK_DOCKER_NETWORK to the host .env file so the Traefik
  // container picks it up on restart. Empty value = no network filter
  // (external routing); "vardo-network" = restrict to vardo-network only.
  const envPath = join(VARDO_HOME_DIR, ".env");
  const networkValue = parsed.data.externalRouting ? "" : "vardo-network";

  try {
    await writeEnvKey(envPath, "TRAEFIK_DOCKER_NETWORK", networkValue);
  } catch (err) {
    log.error(`Failed to write ${envPath}: ${err}`);
    return NextResponse.json(
      { error: "Saved to database but could not update .env — check server permissions" },
      { status: 500 },
    );
  }

  log.info(`Traefik config updated: externalRouting=${parsed.data.externalRouting}`);

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-traefik" });
