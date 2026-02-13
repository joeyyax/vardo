import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { db } from "@/lib/db";
import { emailSends } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logEmailEvent } from "@/lib/activities";

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * POST /api/webhooks/resend
 * Receives delivery event webhooks from Resend (delivered, bounced, opened, clicked, etc.)
 */
export async function POST(request: NextRequest) {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  let event: ResendDeliveryEvent;

  if (webhookSecret) {
    const svixId = request.headers.get("svix-id");
    const svixTimestamp = request.headers.get("svix-timestamp");
    const svixSignature = request.headers.get("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      return NextResponse.json(
        { error: "Missing webhook signature headers" },
        { status: 400 }
      );
    }

    try {
      const payload = await request.text();
      resend.webhooks.verify({
        payload,
        headers: {
          id: svixId,
          timestamp: svixTimestamp,
          signature: svixSignature,
        },
        webhookSecret,
      });
      event = JSON.parse(payload);
    } catch {
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 400 }
      );
    }
  } else {
    event = await request.json();
  }

  // Only process delivery-related events
  const eventType = event.type;
  if (!eventType?.startsWith("email.")) {
    return NextResponse.json({ received: true });
  }

  const resendEmailId = event.data?.email_id;
  if (!resendEmailId) {
    return NextResponse.json({ received: true });
  }

  // Look up the email_sends record
  const emailSend = await db.query.emailSends.findFirst({
    where: eq(emailSends.resendEmailId, resendEmailId),
  });

  if (!emailSend) {
    // Not a tracked email — ignore
    return NextResponse.json({ received: true });
  }

  // Map event type to status and timestamp updates
  const now = new Date();
  const updates: Record<string, unknown> = {};
  let activityAction: "email_delivered" | "email_bounced" | "email_opened" | "email_clicked" | null = null;

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
    case "email.complained":
      updates.status = "complained";
      break;
    case "email.opened":
      updates.openedAt = now;
      // Only update status if not bounced (don't downgrade)
      if (emailSend.status !== "bounced" && emailSend.status !== "complained") {
        updates.status = "opened";
      }
      activityAction = "email_opened";
      break;
    case "email.clicked":
      if (emailSend.status !== "bounced" && emailSend.status !== "complained") {
        updates.status = "clicked";
      }
      activityAction = "email_clicked";
      break;
    case "email.delivery_delayed":
      // Log but don't change status — it may still deliver
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

type ResendDeliveryEvent = {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    created_at: string;
  };
};
