// ---------------------------------------------------------------------------
// Backup exclusions
//
// A volume can name paths a backup leaves out — regenerable cache that would
// otherwise dominate the payload. Two jobs live here: turning operator patterns
// into `find` arguments, and vetting the literal paths that come back.
//
// Patterns are never interpreted by tar. `find` resolves them inside the
// container to literal paths, that list is what tar excludes, and the same list
// is recorded on the backup row so restore knows what the archive left behind.
// One matcher, so backup and restore cannot drift.
//
// Pure — the container work lives in archive.ts.
// ---------------------------------------------------------------------------

export const MAX_EXCLUDE_PATTERNS = 100;
export const MAX_EXCLUDE_PATTERN_LENGTH = 200;

/**
 * Ceiling on how many paths one run may exclude.
 *
 * The list has to be recorded in full: a truncated one leaves paths that are
 * neither in the archive nor protected on the way back, and restore deletes
 * those. Over the ceiling the backup fails instead.
 */
export const MAX_EXCLUDED_PATHS = 10_000;

export class InvalidExclusionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExclusionError";
  }
}

// A newline would split one pattern into two entries of a list file.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function assertSegments(pattern: string, original: string): string[] {
  const segments = pattern.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new InvalidExclusionError(
        `exclusion pattern "${original}" has an empty or relative path segment`,
      );
    }
  }
  return segments;
}

/**
 * Vet one operator pattern and return it relative to the volume root.
 *
 * Leading `/` and `./` are stripped, so a pattern can never name anything
 * outside the volume. A `..` segment is refused rather than resolved.
 */
export function normalizeExcludePattern(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new InvalidExclusionError("exclusion pattern is empty");
  }
  if (trimmed.length > MAX_EXCLUDE_PATTERN_LENGTH) {
    throw new InvalidExclusionError(
      `exclusion pattern is longer than ${MAX_EXCLUDE_PATTERN_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new InvalidExclusionError(
      `exclusion pattern ${JSON.stringify(raw)} contains a control character`,
    );
  }

  const relative = trimmed.replace(/^(?:\.?\/)+/, "").replace(/\/+$/, "");
  if (!relative) {
    throw new InvalidExclusionError(`exclusion pattern "${trimmed}" names the volume root`);
  }
  assertSegments(relative, trimmed);
  return relative;
}

/**
 * `find` arguments that print every path the patterns exclude, topmost first.
 *
 * Matching semantics, which are `find`'s and are the same on busybox and GNU:
 * - No `/` in the pattern — it matches a whole **path segment** at any depth.
 *   `Cache` matches `./Cache` and `./config/Cache`.
 * - Any `/` in the pattern — it matches the **whole path** from the volume root.
 *   `config/Cache` matches only `./config/Cache`.
 * - `*` and `?` are shell globs and `*` spans `/`, so `uploads/*` covers every
 *   depth under `uploads` and `**` means nothing extra.
 * - A matched directory is pruned, so everything under it is excluded too and
 *   only the directory itself appears in the output.
 *
 * Returns an empty argv when there is nothing to exclude; the caller runs the
 * unmodified archive path in that case.
 */
export function buildFindExclusionArgv(patterns: string[]): string[] {
  if (patterns.length > MAX_EXCLUDE_PATTERNS) {
    throw new InvalidExclusionError(
      `${patterns.length} exclusion patterns is over the limit of ${MAX_EXCLUDE_PATTERNS}`,
    );
  }

  const normalized = [...new Set(patterns.map(normalizeExcludePattern))];
  if (normalized.length === 0) return [];

  const alternatives: string[] = [];
  for (const pattern of normalized) {
    if (alternatives.length > 0) alternatives.push("-o");
    alternatives.push(...(pattern.includes("/") ? ["-path", `./${pattern}`] : ["-name", pattern]));
  }

  // -mindepth 1 keeps a pattern such as `*` from pruning the volume root itself.
  return ["-mindepth", "1", "(", ...alternatives, ")", "-prune", "-print"];
}

/**
 * Vet one path the archive left out.
 *
 * Restore moves these back from the live copy into the staging tree, so a value
 * that climbed out of the volume root would write outside it.
 */
export function assertExcludedPath(raw: string): string {
  if (CONTROL_CHARS.test(raw)) {
    throw new InvalidExclusionError(`excluded path ${JSON.stringify(raw)} contains a control character`);
  }
  if (!raw.startsWith("./")) {
    throw new InvalidExclusionError(`excluded path "${raw}" is not relative to the volume root`);
  }
  const relative = raw.slice(2);
  if (!relative) {
    throw new InvalidExclusionError(`excluded path "${raw}" names the volume root`);
  }
  assertSegments(relative, raw);
  return raw;
}

/** The excluded-path list a backup run reported, one path per line. */
export function parseExcludedPaths(raw: string): string[] {
  const lines = raw
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);

  if (lines.length > MAX_EXCLUDED_PATHS) {
    throw new InvalidExclusionError(
      `exclusions matched ${lines.length} paths, over the limit of ${MAX_EXCLUDED_PATHS} — use broader patterns that prune whole directories`,
    );
  }

  return lines.map(assertExcludedPath);
}

/** The file restore reads to decide what to carry over from the live copy. */
export function protectListBody(paths: string[]): string {
  const relative = paths.map((path) => assertExcludedPath(path).slice(2));
  return relative.length > 0 ? `${relative.join("\n")}\n` : "";
}
