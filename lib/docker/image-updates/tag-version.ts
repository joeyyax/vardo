/**
 * Tag parsing and ordering.
 *
 * Every function here refuses rather than guesses: an unrecognized scheme
 * returns `opaque`/`null`, never a comparison. A wrong "up to date" is worse
 * than an honest "can't tell".
 */

/** Tags that move. A digest check is the only way to tell if they changed. */
const FLOATING_WORDS = new Set([
  "latest",
  "stable",
  "main",
  "master",
  "edge",
  "head",
  "dev",
  "devel",
  "develop",
  "development",
  "nightly",
  "canary",
  "rolling",
  "release",
  "prod",
  "production",
  "unstable",
  "current",
  "testing",
  "next",
  "lts",
  "alpha",
  "beta",
  "insiders",
]);

/** Suffix words that mark a pre-release of the version in the core. */
const PRERELEASE_WORDS = new Set([
  "rc",
  "alpha",
  "beta",
  "pre",
  "preview",
  "dev",
  "snapshot",
  "nightly",
  "canary",
  "next",
  "milestone",
  "m",
  "test",
  "experimental",
  "insiders",
  "unstable",
  "eap",
]);

/** Suffix words that mark an image variant, not a version. */
const FLAVOR_WORDS = new Set([
  "alpine",
  "slim",
  "debian",
  "ubuntu",
  "bookworm",
  "bullseye",
  "buster",
  "trixie",
  "jammy",
  "focal",
  "noble",
  "bionic",
  "distroless",
  "scratch",
  "musl",
  "glibc",
  "fpm",
  "apache",
  "nginx",
  "cli",
  "dind",
  "rootless",
  "standalone",
  "full",
  "lite",
  "light",
  "minimal",
  "headless",
  "otel",
  "cuda",
  "rocm",
  "gpu",
  "cpu",
  "jre",
  "jdk",
  "node",
  "python",
  "amd64",
  "arm64",
  "arm32v7",
  "armv7",
  "armhf",
  "windowsservercore",
  "nanoserver",
]);

const CORE_RE = /^(v?)(\d+(?:\.\d+)*)$/;
const LS_BUILD_RE = /^ls(\d+)$/;
const FLAVOR_RE = /^([a-z]+)([\d.]*)$/;
const HEX_BUILD_RE = /^(?:sha-|g|build-)?([0-9a-f]{7,40})$/;
const PRERELEASE_ID_RE = /^([a-z]+)(\d+)$/;

export type PrereleaseId = string | number;

export interface ParsedTag {
  /** `version` orders; `floating` needs a digest check; `opaque` is unorderable. */
  kind: "version" | "floating" | "opaque";
  raw: string;
  /** `v` or empty. Tags with different prefixes are not compared. */
  prefix: string;
  /** Dot-separated numeric core, most significant first. */
  release: number[];
  /** Null means a stable release, which outranks any pre-release. */
  prerelease: PrereleaseId[] | null;
  /** Base variant word, e.g. `alpine` in `1.21-alpine3.19`. */
  flavor: string | null;
  /** Numeric part of the variant, e.g. `3.19` in `alpine3.19`. */
  flavorVersion: number[];
  /** LinuxServer `-lsNNN` build counter. */
  lsBuild: number | null;
  /** Commit hash or similar. Distinguishes identity but carries no order. */
  build: string | null;
}

function opaque(raw: string): ParsedTag {
  return {
    kind: "opaque",
    raw,
    prefix: "",
    release: [],
    prerelease: null,
    flavor: null,
    flavorVersion: [],
    lsBuild: null,
    build: null,
  };
}

function splitPrereleaseIds(segment: string): PrereleaseId[] {
  return segment.split(".").flatMap((id): PrereleaseId[] => {
    if (/^\d+$/.test(id)) return [Number(id)];
    const paired = PRERELEASE_ID_RE.exec(id);
    if (paired) return [paired[1], Number(paired[2])];
    return [id];
  });
}

/** Parses a tag into its orderable parts. Unknown schemes come back `opaque`. */
export function parseTag(input: string): ParsedTag {
  const raw = (input ?? "").trim();
  if (!raw) return { ...opaque(""), kind: "floating", raw: "latest" };

  const lower = raw.toLowerCase();
  const [core, ...segments] = lower.split("-");

  const parsed: ParsedTag = { ...opaque(raw), raw };
  const coreMatch = CORE_RE.exec(core);

  if (coreMatch) {
    parsed.kind = "version";
    parsed.prefix = coreMatch[1];
    parsed.release = coreMatch[2].split(".").map(Number);
  } else if (FLOATING_WORDS.has(core)) {
    parsed.kind = "floating";
  } else {
    return opaque(raw);
  }

  for (const segment of segments) {
    if (!segment) return opaque(raw);

    const ls = LS_BUILD_RE.exec(segment);
    if (ls && parsed.lsBuild === null) {
      parsed.lsBuild = Number(ls[1]);
      continue;
    }

    const head = segment.split(".")[0];
    const word = PRERELEASE_ID_RE.exec(head)?.[1] ?? head;
    if (parsed.prerelease === null && PRERELEASE_WORDS.has(word)) {
      parsed.prerelease = splitPrereleaseIds(segment);
      continue;
    }

    const flavor = FLAVOR_RE.exec(segment);
    if (flavor && FLAVOR_WORDS.has(flavor[1])) {
      parsed.flavor = parsed.flavor ? `${parsed.flavor}-${flavor[1]}` : flavor[1];
      if (flavor[2]) {
        parsed.flavorVersion = flavor[2].split(".").filter(Boolean).map(Number);
      }
      continue;
    }

    const hex = HEX_BUILD_RE.exec(segment);
    if (hex && !/^\d+$/.test(hex[1]) && parsed.build === null) {
      parsed.build = hex[1];
      continue;
    }

    return opaque(raw);
  }

  // A floating core with no orderable parts is still just a pointer.
  if (parsed.kind === "floating") {
    parsed.release = [];
    parsed.prerelease = null;
  }

  return parsed;
}

/** True when the tag is a moving pointer such as `latest` or `stable-alpine`. */
export function isFloatingTag(tag: string): boolean {
  return parseTag(tag).kind === "floating";
}

function compareNumbers(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function comparePrerelease(a: PrereleaseId[], b: PrereleaseId[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (typeof left === "number" && typeof right === "number") {
      if (left !== right) return left > right ? 1 : -1;
      continue;
    }
    // Semver: numeric identifiers rank below alphanumeric ones.
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

/**
 * Orders two tags. Returns null when they are not comparable — different
 * variants, different precision, or an unorderable build suffix.
 */
export function compareTags(
  aTag: string | ParsedTag,
  bTag: string | ParsedTag,
): -1 | 0 | 1 | null {
  const a = typeof aTag === "string" ? parseTag(aTag) : aTag;
  const b = typeof bTag === "string" ? parseTag(bTag) : bTag;

  if (a.kind !== "version" || b.kind !== "version") return null;
  if (a.prefix !== b.prefix) return null;
  if (a.flavor !== b.flavor) return null;
  // `1.26` is usually an alias that tracks `1.26.x`, not a peer of `1.26.2`.
  if (a.release.length !== b.release.length) return null;

  const release = compareNumbers(a.release, b.release);
  if (release !== 0) return release as -1 | 1;

  const flavorVersion = compareNumbers(a.flavorVersion, b.flavorVersion);
  if (flavorVersion !== 0) return flavorVersion as -1 | 1;

  if (a.prerelease === null && b.prerelease !== null) return 1;
  if (a.prerelease !== null && b.prerelease === null) return -1;
  if (a.prerelease !== null && b.prerelease !== null) {
    const pre = comparePrerelease(a.prerelease, b.prerelease);
    if (pre !== 0) return pre as -1 | 1;
  }

  if (a.lsBuild !== null && b.lsBuild !== null) {
    if (a.lsBuild !== b.lsBuild) return a.lsBuild > b.lsBuild ? 1 : -1;
  } else if (a.lsBuild !== null || b.lsBuild !== null) {
    return null;
  }

  if (a.build !== b.build) return null;
  return 0;
}

export type BumpSeverity = "patch" | "minor" | "major" | "build" | "unknown";

/** Which position changed, for UI emphasis. */
export function classifyBump(from: string, to: string): BumpSeverity {
  const a = parseTag(from);
  const b = parseTag(to);
  if (compareTags(a.raw, b.raw) !== -1) return "unknown";

  for (let i = 0; i < a.release.length; i++) {
    if ((a.release[i] ?? 0) === (b.release[i] ?? 0)) continue;
    if (i === 0) return "major";
    if (i === 1) return "minor";
    return "patch";
  }
  return "build";
}

export interface CandidateResult {
  /** Highest orderable tag above the current one, or null. */
  latest: string | null;
  severity: BumpSeverity;
  /** Tags that sort above nothing we understand. Surfaced, never counted. */
  unorderable: string[];
  /** Tags actually compared, for reporting confidence. */
  comparedCount: number;
  /** Every newer tag, newest first — the choices offered in the UI. */
  available: string[];
  /**
   * Newest tag beyond `latest` that crosses a major, when majors were capped.
   * Offered separately so a migration is always a deliberate pick.
   */
  majorAvailable: string | null;
}

/**
 * Picks the newest tag above `currentTag`. Pre-releases are only offered when
 * the current tag is itself a pre-release.
 *
 * With `capAtMajor`, candidates that cross a major are collected into
 * `majorAvailable` rather than becoming `latest`.
 */
export function selectUpdateCandidate(
  currentTag: string,
  availableTags: readonly string[],
  opts: { capAtMajor?: boolean } = {},
): CandidateResult {
  const current = parseTag(currentTag);
  const result: CandidateResult = {
    latest: null,
    severity: "unknown",
    unorderable: [],
    comparedCount: 0,
    available: [],
    majorAvailable: null,
  };
  if (current.kind !== "version") return result;

  const newer: string[] = [];
  let best: string | null = null;
  let bestMajor: string | null = null;

  for (const tag of availableTags) {
    if (tag === current.raw) continue;
    const candidate = parseTag(tag);
    if (candidate.kind !== "version") continue;
    if (candidate.prerelease !== null && current.prerelease === null) continue;

    const order = compareTags(candidate, current);
    if (order === null) {
      if (candidate.flavor === current.flavor && candidate.prefix === current.prefix) {
        result.unorderable.push(tag);
      }
      continue;
    }
    result.comparedCount++;
    if (order !== 1) continue;

    newer.push(candidate.raw);

    const crossesMajor =
      opts.capAtMajor === true && (candidate.release[0] ?? 0) > (current.release[0] ?? 0);
    if (crossesMajor) {
      if (bestMajor === null || compareTags(candidate, bestMajor) === 1) bestMajor = candidate.raw;
      continue;
    }
    if (best === null || compareTags(candidate, best) === 1) best = candidate.raw;
  }

  result.available = newer.sort((a, b) => compareTags(b, a) ?? 0);
  result.latest = best;
  result.majorAvailable = bestMajor;
  if (best) result.severity = classifyBump(current.raw, best);
  return result;
}
