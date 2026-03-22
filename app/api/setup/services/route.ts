import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { getOptionalServicesConfig, setSystemSetting } from "@/lib/system-settings";

const servicesSchema = z.object({
  metrics: z.boolean(),
  logs: z.boolean(),
});

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getOptionalServicesConfig();
  return NextResponse.json({
    configured: true,
    metrics: config.metrics,
    logs: config.logs,
  });
}

export async function POST(request: NextRequest) {
  const setup = await needsSetup();
  if (!setup) {
    await requireAdminAuth(request);
  }

  const body = await request.json();
  const parsed = servicesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { metrics, logs } = parsed.data;

  await setSystemSetting("optional_services", JSON.stringify({ metrics, logs }));

  return NextResponse.json({ ok: true });
}
