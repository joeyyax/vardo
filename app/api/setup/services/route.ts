import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";

export async function POST(request: Request) {
  const setup = await needsSetup();
  if (!setup) {
    await requireSession();
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
