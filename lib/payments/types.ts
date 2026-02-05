// Payment provider types
// Note: This is the foundation for payment integration.
// Actual payments are not enabled yet.

export type PaymentProvider = "stripe" | "polar" | null;

export type PaymentProviderConfig = {
  stripe?: StripeConfig;
  polar?: PolarConfig;
};

export type StripeConfig = {
  // For client invoices - Stripe Connect (payments go directly to freelancer)
  accountId?: string; // Connected account ID
  connected: boolean;
  livemode: boolean;
  // We don't store API keys - use OAuth flow
};

export type PolarConfig = {
  // For SaaS subscriptions (if/when productized)
  organizationId?: string;
  connected: boolean;
  // We don't store API keys - use OAuth flow
};

export type PaymentProviderInfo = {
  id: PaymentProvider;
  name: string;
  description: string;
  useCase: string;
  icon: string; // Lucide icon name
  comingSoon?: boolean;
};

export const PAYMENT_PROVIDERS: PaymentProviderInfo[] = [
  {
    id: "stripe",
    name: "Stripe",
    description: "Accept credit cards, ACH, and more",
    useCase: "Client invoice payments",
    icon: "CreditCard",
  },
  {
    id: "polar",
    name: "Polar",
    description: "Developer-focused payments and subscriptions",
    useCase: "SaaS subscriptions (if productized)",
    icon: "Sparkles",
    comingSoon: true,
  },
];

// Connection status for display
export type ProviderConnectionStatus = {
  provider: PaymentProvider;
  connected: boolean;
  accountName?: string;
  lastChecked?: Date;
};
