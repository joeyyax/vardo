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

// Which buttons appear comes from the database and changes without a rebuild.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const [methods, prerequisites] = await Promise.all([getAuthMethodStates(), checkPrerequisites()]);

  // Password can also be shut off at the deployment level; the others need
  // their prerequisite configured before they can appear.
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
