// Payment provider types

export type PaymentProvider = "stripe" | "polar" | null;

export type PaymentProviderConfig = {
  stripe?: StripeConfig;
  polar?: PolarConfig;
};

export type StripeConfig = {
  connected: boolean;
  livemode: boolean;
};

export type PolarConfig = {
  organizationId?: string;
  connected: boolean;
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
