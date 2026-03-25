"use client";

import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient, magicLinkClient, inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "@/lib/auth";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000",

  plugins: [
    // Passkey client
    passkeyClient(),

    // Two-factor authentication client
    twoFactorClient({
      onTwoFactorRedirect() {
        // Redirect to 2FA verification page when needed
        window.location.href = "/login/2fa";
      },
    }),

    // Magic link client
    magicLinkClient(),

    // Infer additional user fields (isAppAdmin) from server config
    inferAdditionalFields<typeof auth>(),
  ],
});

// Export commonly used hooks and functions
export const {
  signIn,
  signOut,
  signUp,
  useSession,
  getSession,
  // Passkey methods
  passkey,
  // Two-factor methods
  twoFactor,
} = authClient;
