// ---------------------------------------------------------------------------
// App namespace — the compose-safe key for an app's runtime resources
//
// Directory, compose project, volume prefix and Traefik file names all derive
// from this rather than from the app's name, so renaming an app does not move
// anything on disk.
// ---------------------------------------------------------------------------

/** Compose project names must match this. Uppercase is rejected by Compose. */
const COMPOSE_SAFE = /^[a-z0-9][a-z0-9_-]*$/;

/** Length of the random suffix that makes a namespace unique. */
const SUFFIX_LENGTH = 8;

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** True when Compose will accept this as a project name. */
export function isComposeSafe(value: string): boolean {
  return COMPOSE_SAFE.test(value);
}

/**
 * Compose-safe stem from an arbitrary app name. Lowercases, collapses runs of
 * disallowed characters to a single dash, and guarantees a leading alphanumeric.
 */
export function slugifyForCompose(name: string): string {
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/[-_]+$/, "");
  return stem.length > 0 ? stem : "app";
}

function randomSuffix(random: () => number): string {
  let out = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    out += SUFFIX_ALPHABET[Math.floor(random() * SUFFIX_ALPHABET.length)];
  }
  return out;
}

/**
 * A new namespace for an app. Keeps the name as a readable stem so `docker ps`
 * stays legible, and appends a random suffix so two apps sharing a name — across
 * organizations, or after a rename frees the old one — never collide.
 *
 * Pass `random` in tests to make the suffix deterministic.
 */
export function generateNamespace(name: string, random: () => number = Math.random): string {
  return `${slugifyForCompose(name)}-${randomSuffix(random)}`;
}

/**
 * The namespace to use for an app's runtime resources.
 *
 * Apps created before the column exists have no namespace and keep resolving to
 * their name, so nothing on disk moves until they are migrated deliberately.
 */
export function resolveNamespace(app: { name: string; namespace?: string | null }): string {
  return app.namespace?.trim() || app.name;
}
