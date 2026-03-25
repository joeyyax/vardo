import type { Metadata } from "next";
import { isPasswordAuthAllowed } from "@/lib/config/provider-restrictions";
import { isFeatureEnabled } from "@/lib/config/features";
import { LoginPageClient } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Vardo account.",
  openGraph: {
    title: "Sign in to Vardo",
    description: "Sign in to your Vardo account.",
  },
};

export default function LoginPage() {
  // Password auth can be disabled at both the deployment level (env var)
  // and the feature flag level. Both must allow it.
  const allowPasswordAuth = isPasswordAuthAllowed() && isFeatureEnabled("passwordAuth");

  return <LoginPageClient allowPasswordAuth={allowPasswordAuth} />;
}
