import { parseImageRef, refCacheKey } from "./image-ref";

/** A compose pin that the last deploy has not applied yet. */
export interface PendingImage {
  /** Tag the compose file pins. */
  tag: string;
  /** Repository, set only when it differs from the deployed one. */
  repo: string | null;
}

/** Splits `repo[:tag]` the way a card renders it. */
function splitForDisplay(image: string): { repo: string; tag: string } {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash
    ? { repo: image.slice(0, colon), tag: image.slice(colon + 1) }
    : { repo: image, tag: "latest" };
}

/**
 * The compose pin against the image the last deploy ran. Null when they agree
 * or the pin is unusable.
 */
export function pendingImageChange(
  deployed: string | null | undefined,
  pinned: string | null | undefined,
): PendingImage | null {
  if (!deployed || !pinned) return null;

  const from = deployed.trim();
  const to = pinned.trim();
  if (from === to) return null;

  const pinnedRef = parseImageRef(to);
  if (!pinnedRef) return null;

  const deployedRef = parseImageRef(from);
  if (deployedRef && refCacheKey(deployedRef) === refCacheKey(pinnedRef)) return null;

  const shown = splitForDisplay(to);
  return { tag: shown.tag, repo: splitForDisplay(from).repo === shown.repo ? null : shown.repo };
}
