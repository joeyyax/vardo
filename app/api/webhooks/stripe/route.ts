import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookEvent } from "@/lib/payments/stripe";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

/**
 * POST /api/webhooks/stripe
 * Stripe webhook handler for payment events.
 */
export async function POST(request: NextRequest) {
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  const event = verifyWebhookEvent(payload, signature);

  if (!event) {
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 400 }
    );
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(session);
        break;
      }
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutExpired(session);
        break;
      }
      default:
        // Ignore unhandled event types
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Error processing Stripe webhook:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}

/**
 * Handle successful checkout — mark invoice as paid.
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const invoiceId = session.metadata?.invoiceId;
  if (!invoiceId) return;

  await db
    .update(invoices)
    .set({
      status: "paid",
      paidAt: new Date(),
      stripePaymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
      paymentMethod: session.payment_method_types?.[0] ?? null,
    })
    .where(eq(invoices.id, invoiceId));
}

/**
 * Handle expired checkout — clear the stale payment URL.
 */
async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const invoiceId = session.metadata?.invoiceId;
  if (!invoiceId) return;

  await db
    .update(invoices)
    .set({ paymentUrl: null })
    .where(eq(invoices.id, invoiceId));
}
