import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notificationLogs } from "@/lib/db/schema";
import { getEmailProviderConfig } from "@/lib/system-settings";
import { parsePouchEvent, verifyPouchSignature } from "@/lib/email/pouch";
import { logger } from "@/lib/logger";
import { withRateLimit } from "@/lib/api/with-rate-limit";

const log = logger.child("pouch-webhook");

// POST /api/v1/email/pouch/webhook: Pouch delivery events.
async function handler(request: NextRequest) {
  const config = await getEmailProviderConfig();
  if (config?.provider !== "pouch" || !config.webhookSecret) {
    return NextResponse.json({ error: "Pouch webhooks aren't configured" }, { status: 404 });
  }

  const body = await request.text();
  const valid = verifyPouchSignature({
    secret: config.webhookSecret,
    body,
    signature: request.headers.get("x-signature"),
    timestamp: request.headers.get("x-timestamp"),
  });
  if (!valid) {
    log.warn("Rejected Pouch webhook with an invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = parsePouchEvent(payload);
  if (!event) return NextResponse.json({ ok: true, ignored: true });

  const matchesMessage = sql`${notificationLogs.providerMessageIds} @> ARRAY[${event.messageId}]::text[]`;
  // Delivered never overwrites a bounce or complaint from another recipient.
  const where = event.status === "delivered"
    ? and(matchesMessage, or(isNull(notificationLogs.deliveryStatus), eq(notificationLogs.deliveryStatus, "delivered")))
    : matchesMessage;

  await db.update(notificationLogs).set({ deliveryStatus: event.status }).where(where);

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handler, { tier: "public", key: "pouch-webhook" });
