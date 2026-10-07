"use client";

import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient, magicLinkClient, inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "@/lib/auth";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000",

  plugins: [
    passkeyClient(),

    twoFactorClient({
      onTwoFactorRedirect() {
        const url = new URL("/login/2fa", window.location.origin);
        window.location.assign(url);
      },
    }),

    magicLinkClient(),

    // Infers isAppAdmin from the server config.
    inferAdditionalFields<typeof auth>(),
  ],
});

export const {
  signIn,
  signOut,
  signUp,
  useSession,
  getSession,
  passkey,
  twoFactor,
} = authClient;
