import type { Metadata } from "next";
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
  return <LoginPageClient />;
}
