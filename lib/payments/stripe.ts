import Stripe from "stripe";

/**
 * Get a Stripe client instance using the env-configured secret key.
 * Returns null if Stripe is not configured.
 */
export function getStripeClient(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  return new Stripe(secretKey, {
    apiVersion: "2026-01-28.clover",
    typescript: true,
  });
}

/**
 * Check if Stripe is configured (API key present in env).
 */
export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/**
 * Get Stripe connection status for display in settings.
 * Checks env vars and derives test/live mode from key prefix.
 */
export function getStripeStatus(): {
  connected: boolean;
  livemode: boolean;
  hasWebhookSecret: boolean;
  hasPublishableKey: boolean;
} {
  const secretKey = process.env.STRIPE_SECRET_KEY || "";
  const connected = secretKey.length > 0;
  const livemode = secretKey.startsWith("sk_live_");
  const hasWebhookSecret = !!process.env.STRIPE_WEBHOOK_SECRET;
  const hasPublishableKey = !!process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

  return { connected, livemode, hasWebhookSecret, hasPublishableKey };
}

/**
 * Create a Stripe Checkout Session for an invoice payment.
 */
export async function createCheckoutSession({
  invoiceId,
  invoiceNumber,
  amountCents,
  clientName,
  clientEmail,
  successUrl,
  cancelUrl,
}: {
  invoiceId: string;
  invoiceNumber: string;
  amountCents: number;
  clientName: string;
  clientEmail?: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ sessionId: string; url: string } | null> {
  const stripe = getStripeClient();
  if (!stripe) return null;

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `Invoice ${invoiceNumber}`,
            description: `Payment for ${clientName}`,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      invoiceId,
      invoiceNumber,
    },
    customer_email: clientEmail || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  if (!session.url) return null;

  return {
    sessionId: session.id,
    url: session.url,
  };
}

/**
 * Verify a Stripe webhook signature and parse the event.
 */
export function verifyWebhookEvent(
  payload: string | Buffer,
  signature: string
): Stripe.Event | null {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) return null;

  try {
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch {
    return null;
  }
}
