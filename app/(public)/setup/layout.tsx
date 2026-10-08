import type { Metadata } from "next";
import { cookies } from "next/headers";
import { needsSetup } from "@/lib/setup";
import { SETUP_TOKEN_COOKIE, setupTokenState, tokensMatch } from "@/lib/setup-token";
import { SetupTokenGate } from "./setup-token-gate";

export const dynamic = "force-dynamic";

// The setup link carries the token in its query string.
export const metadata: Metadata = { referrer: "no-referrer" };

/** Every setup page waits behind the setup token until the first account exists. */
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  if (await needsSetup()) {
    const state = setupTokenState();
    if (state.mode === "unset") return <SetupTokenGate unset />;
    if (state.mode === "required") {
      const given = (await cookies()).get(SETUP_TOKEN_COOKIE)?.value;
      if (!tokensMatch(given, state.token)) return <SetupTokenGate />;
    }
  }
  return children;
}
