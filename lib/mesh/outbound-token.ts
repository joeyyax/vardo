// ---------------------------------------------------------------------------
// The bearer token a peer gave us, encrypted at rest under the system key.
// ---------------------------------------------------------------------------

import { decryptSystemOrFallback, encryptSystem, isEncrypted } from "@/lib/crypto/encrypt";

/** Ciphertext for storage. Leaves a value that's already encrypted alone. */
export function sealOutboundToken(token: string): string {
  return isEncrypted(token) ? token : encryptSystem(token);
}

/** Plaintext token, or null when it won't decrypt. Legacy plaintext passes through. */
export function openOutboundToken(stored: string): string | null {
  const result = decryptSystemOrFallback(stored);
  return result.decryptFailed ? null : result.content;
}
