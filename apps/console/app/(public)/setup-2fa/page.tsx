import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { needsSecondFactor } from "@/lib/auth/session";
import { Setup2FAClient } from "./setup-2fa-client";

export const metadata: Metadata = {
  title: "Set up two-factor authentication",
  description:
    "Password accounts require a second factor. Set up TOTP or a passkey to continue.",
};

export default async function Setup2FAPage() {
  // If user doesn't need 2FA (already set up, or not password auth), send them home
  if (!(await needsSecondFactor())) {
    redirect("/projects");
  }

  return <Setup2FAClient />;
}
