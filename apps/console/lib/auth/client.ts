"use client";

import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import { magicLinkClient, inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "@/lib/auth";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000",

  plugins: [
    // Passkey client
    passkeyClient(),

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
  useSession,
  getSession,
  // Passkey methods
  passkey,
} = authClient;
