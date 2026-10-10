import { z } from "zod";
import { isSafeBranch, isSafeGitUrl } from "@/lib/docker/validate";

export const gitUrlSchema = z.string().refine(isSafeGitUrl, { message: "Only HTTPS git URLs are allowed" });

export const gitBranchSchema = z.string().refine(isSafeBranch, { message: "Invalid branch name" });

/** Update forms send an empty string to clear the field. */
export const gitUrlUpdateSchema = z.union([gitUrlSchema, z.literal("")]);
export const gitBranchUpdateSchema = z.union([gitBranchSchema, z.literal("")]);

/** Shown in place of the secret part of a git URL's credentials. */
export const GIT_URL_MASK = "********";

/** A git URL with its password, or a lone token, masked. Unparseable input comes back as is. */
export function maskGitUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    if (parsed.password) parsed.password = GIT_URL_MASK;
    else parsed.username = GIT_URL_MASK;
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The stored URL when `next` is its masked form sent back, `next` when unmasked, null when masked with nothing to restore. */
export function unmaskGitUrl(next: string, stored: string | null | undefined): string | null {
  if (!next.includes(GIT_URL_MASK)) return next;
  return stored && maskGitUrl(stored) === next ? stored : null;
}

export const GIT_URL_MASKED_MESSAGE = "The git URL's credentials are masked. Enter them in full.";
