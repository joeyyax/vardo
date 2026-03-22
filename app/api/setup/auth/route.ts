import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";
import { getAuthConfig } from "@/lib/system-settings";

const authSchema = z.object({
  registrationMode: z.enum(["closed", "open", "approval"]),
  sessionDurationDays: z.number().int().min(1).max(365),
});

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getAuthConfig();

  return NextResponse.json({
    configured: true,
    registrationMode: config.registrationMode,
    sessionDurationDays: config.sessionDurationDays,
  });
}

export async function POST(request: NextRequest) {
  await requireAdminAuth(request);

  const body = await request.json();
  const parsed = authSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const config = encryptSystem(JSON.stringify(parsed.data));

  await db
    .insert(systemSettings)
    .values({ key: "auth_config", value: config })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: config, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
