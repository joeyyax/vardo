import type { Metadata } from "next";
import { isPasswordAuthAllowed } from "@/lib/config/provider-restrictions";
import { getAuthMethodStates, checkPrerequisites } from "@/lib/config/auth-methods";
import { LoginPageClient } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Vardo account.",
  openGraph: {
    title: "Sign in to Vardo",
    description: "Sign in to your Vardo account.",
  },
};

// Sign-in methods come from the database.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const [methods, prerequisites] = await Promise.all([getAuthMethodStates(), checkPrerequisites()]);

  // Methods without their prerequisite stay hidden.
  return (
    <LoginPageClient
      methods={{
        password: methods.password && isPasswordAuthAllowed(),
        passkey: methods.passkey,
        magicLink: methods["magic-link"] && prerequisites.email,
        github: methods.github && prerequisites["github-app"],
      }}
    />
  );
}
