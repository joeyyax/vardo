// Backup exclusions: operator patterns to `find` argv, and vetting the literal paths that come back.

export const MAX_EXCLUDE_PATTERNS = 100;
export const MAX_EXCLUDE_PATTERN_LENGTH = 200;

/** Max excluded paths per run. Never truncate the list: restore deletes unlisted paths. */
export const MAX_EXCLUDED_PATHS = 10_000;

export class InvalidExclusionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExclusionError";
  }
}

// A newline would split one pattern into two entries of a list file.
 
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

/** Vet one operator pattern and return it relative to the volume root. Refuses `..`. */
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
 * `find` arguments that print every excluded path, topmost first. Empty when nothing is excluded.
 * No `/` matches a segment at any depth; a `/` matches from the root; `*` spans `/`.
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

/** Vet one path the archive left out. Restore writes to it, so it must stay inside the volume. */
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
