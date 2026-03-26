import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getTraefikConfig, setSystemSetting, invalidateSettingsCache } from "@/lib/system-settings";

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

  return NextResponse.json({ ok: true });
}
