// Clone targets can't reach internal hosts unless VARDO_OUTBOUND_ALLOWLIST (or the outbound_allowlist setting) names them.

import { assertOutboundUrlAllowed } from "@/lib/security/ssrf";
import { getOutboundPolicy } from "@/lib/security/outbound-policy";

/** Git args that stop a clone or fetch following an HTTP redirect to another host. */
export const GIT_NO_REDIRECT = ["-c", "http.followRedirects=false"];

/** Throws BlockedUrlError when the git URL's host resolves to a private, loopback, link-local or metadata address. */
export async function assertGitHostAllowed(gitUrl: string): Promise<void> {
  await assertOutboundUrlAllowed(gitUrl, await getOutboundPolicy());
}
