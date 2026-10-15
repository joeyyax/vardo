// Which tagged images nothing needs. Pure; every keep has a reason.

import { parseImageRef, refCacheKey } from "../image-updates/image-ref";

/** Images Vardo runs helper containers from. Re-pulling them mid-backup is a failure mode. */
const HELPER_REPOSITORIES = ["docker.io/library/alpine"];

/** Vardo's own images, whatever registry they came from. */
const SELF_REPOSITORY = /(^|\/)vardo(-[a-z0-9]+)?$/i;

export interface Protection {
  /** `registry/repository:tag` keys. */
  tags: Set<string>;
  /** `registry/repository@digest` keys. */
  digests: Set<string>;
  /** Literal text before a `${...}` in a ref. Any tag starting with one is kept. */
  prefixes: Set<string>;
}

export function emptyProtection(): Protection {
  return { tags: new Set(), digests: new Set(), prefixes: new Set() };
}

function digestKey(ref: string): string | null {
  const parsed = parseImageRef(ref);
  if (!parsed?.digest) return null;
  return `${parsed.registry}/${parsed.repository}@${parsed.digest}`;
}

function tagKey(ref: string): string | null {
  const parsed = parseImageRef(ref);
  return parsed ? refCacheKey(parsed) : null;
}

/** Add one image reference as written in a compose file, an app row or a snapshot. */
export function protectRef(p: Protection, raw: string | null | undefined): void {
  const ref = raw?.trim();
  if (!ref) return;
  const dollar = ref.indexOf("$");
  if (dollar !== -1) {
    const literal = ref.slice(0, dollar);
    const colon = literal.lastIndexOf(":");
    // `repo:${TAG}` keeps every tag of repo; a bare `${IMAGE}` names nothing to match.
    if (colon > literal.lastIndexOf("/") && colon > 0) {
      const key = tagKey(`${literal.slice(0, colon)}:x`);
      if (key) p.prefixes.add(key.slice(0, -1));
    }
    if (literal.length >= 3) p.prefixes.add(literal);
    return;
  }
  const digest = digestKey(ref);
  if (digest) p.digests.add(digest);
  const key = tagKey(ref);
  if (key) p.tags.add(key);
}

/** `image:` values in raw compose text, `${...}` refs included. Text-level so nothing is lost to parsing. */
export function composeImageRefs(content: string | null | undefined): string[] {
  if (!content) return [];
  const refs: string[] = [];
  for (const match of content.matchAll(/^\s+image:\s*["']?([^"'\s#]+)["']?/gm)) refs.push(match[1]);
  return refs;
}

export interface ImageRow {
  id: string;
  repoTags: string[];
  repoDigests?: string[];
  size: number;
  labels: Record<string, string>;
}

export interface ContainerRow {
  image: string;
  imageId?: string;
}

export type KeepReason =
  | "untagged"
  | "in-use"
  | "compose-build"
  | "referenced"
  | "helper"
  | "recent"
  | "age-unknown";

export interface UnusedImage {
  id: string;
  tags: string[];
  size: number;
}

export interface ImageSelection {
  candidates: UnusedImage[];
  kept: Record<KeepReason, number>;
}

function realTags(tags: string[]): string[] {
  return tags.filter((t) => t && t !== "<none>:<none>");
}

/** Why an image stays, or null when nothing needs it. */
export function keepReason(image: ImageRow, inUse: { ids: Set<string>; refs: Set<string> }, p: Protection): KeepReason | null {
  const tags = realTags(image.repoTags);
  if (tags.length === 0) return "untagged";
  if (inUse.ids.has(image.id)) return "in-use";
  if (tags.some((t) => inUse.refs.has(t) || inUse.refs.has(tagKey(t) ?? ""))) return "in-use";
  // Compose-built slot images belong to the slot sweep, which knows which slot is live.
  if (image.labels["com.docker.compose.project"]) return "compose-build";

  for (const tag of tags) {
    const key = tagKey(tag);
    const repo = key ? key.slice(0, key.lastIndexOf(":")) : "";
    if (HELPER_REPOSITORIES.includes(repo)) return "helper";
    if (SELF_REPOSITORY.test(repo)) return "helper";
    if (key && p.tags.has(key)) return "referenced";
    for (const prefix of p.prefixes) {
      if (tag.startsWith(prefix) || (key && key.startsWith(prefix))) return "referenced";
    }
  }
  for (const d of image.repoDigests ?? []) {
    const key = digestKey(d);
    if (key && p.digests.has(key)) return "referenced";
  }
  return null;
}

function emptyKept(): Record<KeepReason, number> {
  return { untagged: 0, "in-use": 0, "compose-build": 0, referenced: 0, helper: 0, recent: 0, "age-unknown": 0 };
}

/** Tagged images no container uses and no app, deployment or helper references. Age is checked after. */
export function selectUnusedImages(images: ImageRow[], containers: ContainerRow[], p: Protection): ImageSelection {
  const inUse = { ids: new Set<string>(), refs: new Set<string>() };
  for (const c of containers) {
    if (c.imageId) inUse.ids.add(c.imageId);
    inUse.ids.add(c.image);
    inUse.refs.add(c.image);
    const key = tagKey(c.image);
    if (key) inUse.refs.add(key);
  }

  const kept = emptyKept();
  const candidates: UnusedImage[] = [];
  for (const image of images) {
    const reason = keepReason(image, inUse, p);
    if (reason) {
      kept[reason]++;
      continue;
    }
    candidates.push({ id: image.id, tags: realTags(image.repoTags), size: image.size });
  }
  return { candidates, kept };
}

/** Drop candidates tagged or built within `minAgeMs`. An unreadable time keeps the image. */
export function olderThan(
  selection: ImageSelection,
  taggedAt: Map<string, number | null>,
  now: number,
  minAgeMs: number,
): ImageSelection {
  const kept = { ...selection.kept };
  const candidates: UnusedImage[] = [];
  for (const c of selection.candidates) {
    const at = taggedAt.get(c.id);
    if (at == null) {
      kept["age-unknown"]++;
    } else if (now - at < minAgeMs) {
      kept.recent++;
    } else {
      candidates.push(c);
    }
  }
  return { candidates, kept };
}

/** Compose `run` containers that exited long enough ago. Nothing else is a one-off. */
export function staleOneOffs(
  containers: { id: string; state: string; labels: Record<string, string>; created?: number }[],
  now: number,
  minAgeMs: number,
): string[] {
  return containers
    .filter(
      (c) =>
        c.labels["com.docker.compose.oneoff"]?.toLowerCase() === "true" &&
        (c.state === "exited" || c.state === "created" || c.state === "dead") &&
        typeof c.created === "number" &&
        now - c.created * 1000 >= minAgeMs,
    )
    .map((c) => c.id);
}
