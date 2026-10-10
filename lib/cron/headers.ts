// Request headers for URL jobs, encrypted at rest with the org's key.

import { decrypt, encrypt } from "@/lib/crypto/encrypt";
import { HEADER_MASK, type CronHeaderInput } from "./url-options";

export type CronHeader = { name: string; value: string };

export function encryptHeaders(headers: CronHeader[], orgId: string): string | null {
  return headers.length > 0 ? encrypt(JSON.stringify(headers), orgId) : null;
}

/** Stored headers, or an empty list when there are none. Throws when they can't be decrypted. */
export function decryptHeaders(stored: string | null | undefined, orgId: string): CronHeader[] {
  if (!stored) return [];
  const parsed = JSON.parse(decrypt(stored, orgId)) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (h): h is CronHeader => typeof h?.name === "string" && typeof h?.value === "string",
  );
}

/** Names with the values masked, for API responses. */
export function maskHeaders(stored: string | null | undefined, orgId: string): { name: string; value: string }[] {
  try {
    return decryptHeaders(stored, orgId).map((h) => ({ name: h.name, value: HEADER_MASK }));
  } catch {
    return [];
  }
}

/** Incoming headers with omitted or masked values filled from the stored ones. Throws on a new header with no value. */
export function mergeHeaders(incoming: CronHeaderInput[], stored: CronHeader[]): CronHeader[] {
  const byName = new Map(stored.map((h) => [h.name.toLowerCase(), h.value]));
  return incoming.map((h) => {
    if (h.value !== undefined && h.value !== HEADER_MASK) return { name: h.name, value: h.value };
    const kept = byName.get(h.name.toLowerCase());
    if (kept === undefined) throw new HeaderValueMissingError(h.name);
    return { name: h.name, value: kept };
  });
}

export class HeaderValueMissingError extends Error {
  constructor(name: string) {
    super(`Header ${name} needs a value`);
    this.name = "HeaderValueMissingError";
  }
}
