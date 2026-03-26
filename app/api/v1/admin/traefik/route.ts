import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { join } from "path";
import { spawn } from "child_process";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getTraefikConfig, setSystemSetting, invalidateSettingsCache } from "@/lib/system-settings";
import { writeEnvKey } from "@/lib/env/write-env-key";
import { logger } from "@/lib/logger";

const log = logger.child("admin:traefik");

const traefikConfigSchema = z.object({
  externalRouting: z.boolean(),
});

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getTraefikConfig();
  return NextResponse.json(config);
}

export async function POST(request: NextRequest) {
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
  const envPath = join(process.env.VARDO_DIR ?? "/opt/vardo", ".env");
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

  // Restart the Traefik container so it picks up the new network setting.
  // Detached + unref so the process outlives the request.
  spawn("docker", ["restart", "vardo-traefik"], {
    detached: true,
    stdio: "ignore",
  }).unref();

  log.info(`Traefik config updated: externalRouting=${parsed.data.externalRouting}`);

  return NextResponse.json({ ok: true });
}
