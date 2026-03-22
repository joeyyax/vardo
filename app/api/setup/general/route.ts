import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";
import { getInstanceConfig } from "@/lib/system-settings";

const generalSchema = z.object({
  instanceName: z.string().min(1).max(100),
  baseDomain: z.string().optional(),
  serverIp: z.string().optional(),
});

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getInstanceConfig();

  return NextResponse.json({
    configured: true,
    instanceName: config.instanceName,
    baseDomain: config.baseDomain,
    serverIp: config.serverIp,
  });
}

export async function POST(request: NextRequest) {
  const setup = await needsSetup();
  if (!setup) {
    await requireAdminAuth(request);
  }

  const body = await request.json();
  const parsed = generalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  // Only instanceName is editable; preserve baseDomain and serverIp from existing config
  const existing = await getInstanceConfig();

  const config = encryptSystem(JSON.stringify({
    instanceName: parsed.data.instanceName,
    baseDomain: existing.baseDomain,
    serverIp: existing.serverIp,
  }));

  await db
    .insert(systemSettings)
    .values({ key: "instance_config", value: config })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: config, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
