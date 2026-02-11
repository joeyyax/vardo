"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CreditCard,
  Sparkles,
  Check,
  AlertTriangle,
  TestTube,
} from "lucide-react";
import { cn } from "@/lib/utils";

type StripeStatus = {
  connected: boolean;
  livemode: boolean;
  hasWebhookSecret: boolean;
  hasPublishableKey: boolean;
};

type PaymentSettingsProps = {
  organizationId: string;
  stripeStatus: StripeStatus;
  canEdit: boolean;
};

export function PaymentSettings({
  stripeStatus,
}: PaymentSettingsProps) {
  return (
    <Card className="squircle">
      <CardHeader>
        <CardTitle>Payment Providers</CardTitle>
        <CardDescription>
          Connect a payment provider to accept payments on invoices.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stripe */}
        <div
          className={cn(
            "flex items-center justify-between rounded-lg border p-4",
            stripeStatus.connected &&
              "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950"
          )}
        >
          <div className="flex items-center gap-4">
            <div
              className={cn(
                "flex size-10 items-center justify-center rounded-lg",
                stripeStatus.connected
                  ? "bg-green-100 dark:bg-green-900"
                  : "bg-muted"
              )}
            >
              <CreditCard
                className={cn(
                  "size-5",
                  stripeStatus.connected
                    ? "text-green-600 dark:text-green-400"
                    : "text-muted-foreground"
                )}
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">Stripe</span>
                {stripeStatus.connected ? (
                  <>
                    <Badge
                      variant="outline"
                      className="gap-1 border-green-200 text-green-600 dark:border-green-800 dark:text-green-400"
                    >
                      <Check className="size-3" />
                      Connected
                    </Badge>
                    {stripeStatus.livemode ? (
                      <Badge variant="outline" className="text-xs">
                        Live
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="gap-1 text-xs border-amber-200 text-amber-600 dark:border-amber-800 dark:text-amber-400"
                      >
                        <TestTube className="size-3" />
                        Test Mode
                      </Badge>
                    )}
                  </>
                ) : (
                  <Badge variant="secondary" className="text-xs">
                    Not Configured
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Accept credit cards, ACH, and more
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Use case: Client invoice payments
              </p>
            </div>
          </div>
        </div>

        {/* Stripe configuration details */}
        {stripeStatus.connected && (
          <div className="rounded-lg border p-4 space-y-2">
            <p className="text-sm font-medium">Configuration Status</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
              <ConfigItem
                label="Secret Key"
                configured={true}
              />
              <ConfigItem
                label="Webhook Secret"
                configured={stripeStatus.hasWebhookSecret}
              />
              <ConfigItem
                label="Publishable Key"
                configured={stripeStatus.hasPublishableKey}
              />
            </div>
            {(!stripeStatus.hasWebhookSecret || !stripeStatus.hasPublishableKey) && (
              <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1 mt-1">
                <AlertTriangle className="size-3" />
                Missing keys will limit payment functionality. Add them to your
                environment variables.
              </p>
            )}
          </div>
        )}

        {!stripeStatus.connected && (
          <div className="rounded-lg border border-dashed p-4">
            <p className="text-sm text-muted-foreground">
              To enable Stripe payments, add your API keys to your environment
              variables:
            </p>
            <pre className="mt-2 rounded bg-muted p-3 text-xs font-mono overflow-x-auto">
{`STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_..."`}
            </pre>
            <p className="text-xs text-muted-foreground mt-2">
              Get your keys from the{" "}
              <a
                href="https://dashboard.stripe.com/apikeys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-4"
              >
                Stripe Dashboard
              </a>
              . Use test keys for development.
            </p>
          </div>
        )}

        {/* Polar (Coming Soon) */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="flex items-center gap-4">
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
              <Sparkles className="size-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">Polar</span>
                <Badge variant="secondary" className="text-xs">
                  Coming Soon
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Developer-focused payments and subscriptions
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Use case: SaaS subscriptions (if productized)
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfigItem({
  label,
  configured,
}: {
  label: string;
  configured: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {configured ? (
        <Check className="size-3.5 text-green-600 dark:text-green-400" />
      ) : (
        <AlertTriangle className="size-3.5 text-amber-500" />
      )}
      <span className={cn(!configured && "text-muted-foreground")}>
        {label}
      </span>
    </div>
  );
}
