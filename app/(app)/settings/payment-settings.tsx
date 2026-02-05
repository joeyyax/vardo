"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
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
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PaymentProvider } from "@/lib/payments/types";
import { PAYMENT_PROVIDERS } from "@/lib/payments/types";

type PaymentSettingsProps = {
  organizationId: string;
  currentProvider: PaymentProvider;
  connected: boolean;
  canEdit: boolean;
};

const ICON_MAP = {
  CreditCard,
  Sparkles,
};

export function PaymentSettings({
  organizationId,
  currentProvider,
  connected,
  canEdit,
}: PaymentSettingsProps) {
  const [isConnecting, setIsConnecting] = useState<PaymentProvider>(null);

  async function handleConnect(provider: PaymentProvider) {
    if (!provider || !canEdit) return;

    setIsConnecting(provider);

    // For now, just show a message that this isn't enabled yet
    // In the future, this would initiate OAuth flow
    setTimeout(() => {
      setIsConnecting(null);
    }, 1000);
  }

  return (
    <Card className="squircle">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Payment Providers</CardTitle>
            <CardDescription>
              Connect a payment provider to accept payments on invoices.
            </CardDescription>
          </div>
          <Badge variant="outline" className="gap-1">
            <AlertCircle className="size-3" />
            Coming Soon
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {PAYMENT_PROVIDERS.map((provider) => {
          const Icon = ICON_MAP[provider.icon as keyof typeof ICON_MAP] || CreditCard;
          const isConnected = currentProvider === provider.id && connected;
          const isLoading = isConnecting === provider.id;

          return (
            <div
              key={provider.id}
              className={cn(
                "flex items-center justify-between rounded-lg border p-4",
                isConnected && "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950"
              )}
            >
              <div className="flex items-center gap-4">
                <div
                  className={cn(
                    "flex size-10 items-center justify-center rounded-lg",
                    isConnected
                      ? "bg-green-100 dark:bg-green-900"
                      : "bg-muted"
                  )}
                >
                  <Icon
                    className={cn(
                      "size-5",
                      isConnected
                        ? "text-green-600 dark:text-green-400"
                        : "text-muted-foreground"
                    )}
                  />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{provider.name}</span>
                    {provider.comingSoon && (
                      <Badge variant="secondary" className="text-xs">
                        Coming Soon
                      </Badge>
                    )}
                    {isConnected && (
                      <Badge
                        variant="outline"
                        className="gap-1 border-green-200 text-green-600 dark:border-green-800 dark:text-green-400"
                      >
                        <Check className="size-3" />
                        Connected
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {provider.description}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Use case: {provider.useCase}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {isConnected ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canEdit}
                    className="squircle"
                  >
                    Manage
                    <ExternalLink className="size-3 ml-1" />
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canEdit || provider.comingSoon || isLoading}
                    className="squircle"
                    onClick={() => handleConnect(provider.id)}
                  >
                    {isLoading ? "Connecting..." : "Connect"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        <p className="text-xs text-muted-foreground pt-2">
          Payment integration is being built. You&apos;ll be able to connect Stripe to accept
          credit card and ACH payments on invoices. Polar support will follow for SaaS subscription
          billing if this tool is productized.
        </p>
      </CardContent>
    </Card>
  );
}
