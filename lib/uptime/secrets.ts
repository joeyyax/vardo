// A monitor's request headers, encrypted at rest. Values leave this module only to be sent with a check; nothing here logs them.

import { decrypt, decryptSystem, encrypt, encryptSystem } from "@/lib/crypto/encrypt";
import { basicAuthHeader, headersProblem, type HeaderInput } from "./core";
import { UptimeInputError } from "./errors";

export type HeaderPatch = {
  /** The full set to keep. A missing value keeps the stored one for that name. */
  headers?: { name: string; value?: string }[];
  basicAuth?: { username: string; password: string };
};

type Owner = { organizationId: string | null };

export function sealHeaders(headers: Record<string, string>, owner: Owner): string | null {
  if (Object.keys(headers).length === 0) return null;
  const json = JSON.stringify(headers);
  return owner.organizationId ? encrypt(json, owner.organizationId) : encryptSystem(json);
}

/** The stored headers, or an empty set when none are stored or they can't be read. */
export function openHeaders(sealed: string | null | undefined, owner: Owner): Record<string, string> {
  if (!sealed) return {};
  try {
    return JSON.parse(owner.organizationId ? decrypt(sealed, owner.organizationId) : decryptSystem(sealed)) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Applies a patch to the stored set. Returns what to store and the names to show; throws UptimeInputError on a bad set. */
export function applyHeaderPatch(sealed: string | null | undefined, owner: Owner, patch: HeaderPatch): { sealed: string | null; names: string[] } {
  const existing = openHeaders(sealed, owner);
  const byLower = new Map(Object.entries(existing).map(([name, value]) => [name.toLowerCase(), value]));
  let list: HeaderInput[];
  if (patch.headers) {
    list = patch.headers.map(({ name, value }) => {
      const kept = value ?? byLower.get(name.toLowerCase());
      if (!kept) throw new UptimeInputError(`Enter a value for ${name}.`);
      return { name, value: kept };
    });
  } else {
    list = Object.entries(existing).map(([name, value]) => ({ name, value }));
  }
  if (patch.basicAuth) {
    const auth = basicAuthHeader(patch.basicAuth.username, patch.basicAuth.password);
    list = [...list.filter((h) => h.name.toLowerCase() !== "authorization"), auth];
  }
  const problem = headersProblem(list);
  if (problem) throw new UptimeInputError(problem);
  const map = Object.fromEntries(list.map((h) => [h.name, h.value]));
  return { sealed: sealHeaders(map, owner), names: list.map((h) => h.name) };
}
