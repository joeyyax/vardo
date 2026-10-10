// Git URL credentials, stored apart from the URL and encrypted per org.

import { decryptOrFallback, encrypt } from "@/lib/crypto/encrypt";
import { joinGitUrl, KEEP_GIT_CREDENTIALS, resolveGitUrlInput, splitGitUrl } from "@/lib/api/git-fields";

export function sealGitCredentials(credentials: string | null, orgId: string): string | null {
  return credentials ? encrypt(credentials, orgId) : null;
}

/** Plaintext credentials, or null when none are stored. Throws when they won't decrypt. */
export function openGitCredentials(sealed: string | null | undefined, orgId: string): string | null {
  if (!sealed) return null;
  const { content, decryptFailed } = decryptOrFallback(sealed, orgId);
  if (decryptFailed) throw new Error("The git credentials can't be decrypted");
  return content || null;
}

/** The full git URL, credentials included. In memory only. */
export function openGitUrl(app: { gitUrl: string | null; gitCredentials?: string | null }, orgId: string): string | null {
  if (!app.gitUrl) return null;
  return joinGitUrl(splitGitUrl(app.gitUrl).url, openGitCredentials(app.gitCredentials, orgId));
}

/** Columns for a new app's git URL. */
export function gitUrlColumns(url: string | null | undefined, orgId: string): { gitUrl: string | null; gitCredentials: string | null } {
  if (!url) return { gitUrl: url ?? null, gitCredentials: null };
  const split = splitGitUrl(url);
  return { gitUrl: split.url, gitCredentials: sealGitCredentials(split.credentials, orgId) };
}

/** Columns for an edited git URL, or null when masked credentials have nothing to keep. */
export function gitUrlUpdateColumns(
  next: string | null,
  stored: { gitUrl: string | null; gitCredentials: string | null },
  orgId: string,
): { gitUrl: string | null; gitCredentials?: string | null } | null {
  if (!next) return { gitUrl: next, gitCredentials: null };
  const resolved = resolveGitUrlInput(next, { gitUrl: stored.gitUrl, hasCredentials: !!stored.gitCredentials });
  if (!resolved) return null;
  if (resolved.credentials === KEEP_GIT_CREDENTIALS) return { gitUrl: resolved.url };
  return { gitUrl: resolved.url, gitCredentials: sealGitCredentials(resolved.credentials, orgId) };
}
