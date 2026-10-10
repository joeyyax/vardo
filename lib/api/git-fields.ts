import { z } from "zod";
import { isSafeBranch, isSafeGitUrl } from "@/lib/docker/validate";

export const gitUrlSchema = z.string().refine(isSafeGitUrl, { message: "Only HTTPS git URLs are allowed" });

export const gitBranchSchema = z.string().refine(isSafeBranch, { message: "Invalid branch name" });

/** Update forms send an empty string to clear the field. */
export const gitUrlUpdateSchema = z.union([gitUrlSchema, z.literal("")]);
export const gitBranchUpdateSchema = z.union([gitBranchSchema, z.literal("")]);

/** Shown in place of a git URL's credentials. */
export const GIT_URL_MASK = "********";

const URL_PARTS = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i;

/** A git URL without its userinfo, and the userinfo. Unparseable input comes back whole. */
export function splitGitUrl(url: string): { url: string; credentials: string | null } {
  const m = URL_PARTS.exec(url);
  const at = m ? m[2].lastIndexOf("@") : -1;
  if (!m || at < 0) return { url, credentials: null };
  return { url: m[1] + m[2].slice(at + 1) + m[3], credentials: m[2].slice(0, at) || null };
}

/** A credential-free git URL with `credentials` as its userinfo. */
export function joinGitUrl(url: string, credentials: string | null | undefined): string {
  const m = credentials ? URL_PARTS.exec(url) : null;
  return m ? `${m[1]}${credentials}@${m[2]}${m[3]}` : url;
}

/** Lowercased host and port of a git URL. */
export function gitUrlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = URL_PARTS.exec(splitGitUrl(url).url);
  return m ? m[2].toLowerCase() : null;
}

/** A git URL with its credentials, embedded or stored, shown as the mask. */
export function maskGitUrl(url: string | null | undefined, hasStoredCredentials = false): string | null | undefined {
  if (!url) return url;
  const split = splitGitUrl(url);
  return joinGitUrl(split.url, split.credentials || hasStoredCredentials ? GIT_URL_MASK : null);
}

export const KEEP_GIT_CREDENTIALS = Symbol("keep-git-credentials");

/** A submitted git URL and the credentials to store. The mask keeps them on the same host, clears them on another, and is null with none stored. */
export function resolveGitUrlInput(
  next: string,
  stored: { gitUrl: string | null; hasCredentials: boolean },
): { url: string; credentials: string | null | typeof KEEP_GIT_CREDENTIALS } | null {
  const { url, credentials } = splitGitUrl(next);
  if (!credentials?.includes(GIT_URL_MASK)) return { url, credentials };
  if (gitUrlHost(url) !== gitUrlHost(stored.gitUrl)) return { url, credentials: null };
  return stored.hasCredentials ? { url, credentials: KEEP_GIT_CREDENTIALS } : null;
}

export const GIT_URL_MASKED_MESSAGE = "The git URL's credentials are masked. Enter them in full.";
