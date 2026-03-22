import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { getOptionalServicesConfig } from "@/lib/system-settings";

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
  const { metrics, logs } = body;

  const config = JSON.stringify({ metrics: !!metrics, logs: !!logs });

  await db
    .insert(systemSettings)
    .values({ key: "optional_services", value: config })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: config, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
