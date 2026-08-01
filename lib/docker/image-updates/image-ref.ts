/** Parsing for `[registry[:port]/]repository[:tag][@digest]` references. */

export interface ImageRef {
  /** Registry host, defaulting to `docker.io`. */
  registry: string;
  /** Path without the registry, `library/` filled in for bare Docker Hub names. */
  repository: string;
  tag: string;
  /** Set when the ref is pinned by digest, in which case the tag is advisory. */
  digest: string | null;
  /** The ref as written. */
  raw: string;
}

const DEFAULT_REGISTRY = "docker.io";

function looksLikeRegistry(segment: string): boolean {
  return segment === "localhost" || segment.includes(".") || segment.includes(":");
}

/** Returns null when the ref is unusable, e.g. it interpolates a variable. */
export function parseImageRef(input: string): ImageRef | null {
  const raw = (input ?? "").trim();
  if (!raw || raw.includes("$")) return null;

  let rest = raw;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1) || null;
    rest = rest.slice(0, at);
  }

  const slash = rest.indexOf("/");
  let registry = DEFAULT_REGISTRY;
  let path = rest;
  if (slash !== -1 && looksLikeRegistry(rest.slice(0, slash))) {
    registry = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  }

  let tag = "";
  const colon = path.lastIndexOf(":");
  if (colon !== -1 && !path.slice(colon + 1).includes("/")) {
    tag = path.slice(colon + 1);
    path = path.slice(0, colon);
  }
  if (!path) return null;

  if (registry === "docker.io" || registry === "index.docker.io") {
    registry = DEFAULT_REGISTRY;
    if (!path.includes("/")) path = `library/${path}`;
  }

  return { registry, repository: path, tag: tag || "latest", digest, raw };
}

/** Rebuilds a ref, swapping in a new tag and dropping any digest pin. */
export function withTag(ref: ImageRef, tag: string): string {
  const registry = ref.registry === DEFAULT_REGISTRY ? "" : `${ref.registry}/`;
  const repository =
    ref.registry === DEFAULT_REGISTRY && ref.repository.startsWith("library/")
      ? ref.repository.slice("library/".length)
      : ref.repository;
  return `${registry}${repository}:${tag}`;
}

/** Stable key for caching. Digest pins collapse onto their tag. */
export function refCacheKey(ref: ImageRef): string {
  return `${ref.registry}/${ref.repository}:${ref.tag}`;
}

/**
 * LinuxServer publishes both `4.0.17.2952-ls314` (immutable) and `4.0.17`,
 * which moves. Short forms need a digest check even though they parse as versions.
 */
export function isMutableShortForm(ref: ImageRef, tag: string): boolean {
  const linuxserver = /(^|\/)linuxserver\//.test(`/${ref.repository}`);
  return linuxserver && !/-ls\d+$/.test(tag);
}
