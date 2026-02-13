import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { emailSends } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logEmailEvent } from "@/lib/activities";

/**
 * POST /api/webhooks/mailpace
 * Receives delivery event webhooks from MailPace (delivered, bounced, deferred, spam).
 */
export async function POST(request: NextRequest) {
  const payload = await request.text();

  // Verify Ed25519 signature if public key is configured
  const publicKey = process.env.MAILPACE_WEBHOOK_PUBLIC_KEY;
  if (publicKey) {
    const signature = request.headers.get("X-MailPace-Signature");
    if (!signature) {
      return NextResponse.json(
        { error: "Missing webhook signature" },
        { status: 400 }
      );
    }

    try {
      const isValid = crypto.verify(
        null,
        Buffer.from(payload),
        {
          key: Buffer.from(publicKey, "base64"),
          format: "der",
          type: "spki",
        },
        Buffer.from(signature, "base64")
      );

      if (!isValid) {
        return NextResponse.json(
          { error: "Invalid webhook signature" },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Signature verification failed" },
        { status: 400 }
      );
    }
  }

  let event: MailPaceDeliveryEvent;
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Only process email events
  const eventType = event.event;
  if (!eventType?.startsWith("email.")) {
    return NextResponse.json({ received: true });
  }

  const mailpaceId = event.payload?.id;
  if (!mailpaceId) {
    return NextResponse.json({ received: true });
  }

  // Look up the email_sends record by MailPace ID (stored as string)
  const externalId = String(mailpaceId);
  const emailSend = await db.query.emailSends.findFirst({
    where: eq(emailSends.externalEmailId, externalId),
  });

  if (!emailSend) {
    // Not a tracked email — ignore
    return NextResponse.json({ received: true });
  }

  // Map event type to status and timestamp updates
  const now = new Date();
  const updates: Record<string, unknown> = {};
  let activityAction: "email_delivered" | "email_bounced" | null = null;

  switch (eventType) {
    case "email.delivered":
      updates.status = "delivered";
      updates.deliveredAt = now;
      activityAction = "email_delivered";
      break;
    case "email.bounced":
      updates.status = "bounced";
      updates.bouncedAt = now;
      activityAction = "email_bounced";
      break;
    case "email.deferred":
      // Log but don't change status — it may still deliver
      break;
    case "email.spam":
      updates.status = "complained";
      break;
    default:
      return NextResponse.json({ received: true });
  }

  // Update email_sends record
  if (Object.keys(updates).length > 0) {
    await db
      .update(emailSends)
      .set(updates)
      .where(eq(emailSends.id, emailSend.id));
  }

  // Log activity for significant events
  if (activityAction) {
    await logEmailEvent({
      emailSendId: emailSend.id,
      action: activityAction,
      recipientEmail: emailSend.recipientEmail,
      organizationId: emailSend.organizationId,
      entityType: emailSend.entityType,
      entityId: emailSend.entityId,
    });
  }

  return NextResponse.json({ received: true });
}

type MailPaceDeliveryEvent = {
  event: string;
  payload: {
    id: number;
    status: string;
    from: string;
    to: string;
  };
};
