// Health endpoint detection: reading a path out of a container healthcheck, deciding which responses qualify, and judging the homepage.

import { createHash } from "node:crypto";

/** Paths tried, in order, when the app's own healthcheck names none. */
export const HEALTH_PATHS = ["/healthz", "/health", "/api/health", "/api/healthz", "/up", "/livez", "/readyz", "/ping", "/status", "/_health"] as const;

/** A path a known image serves when up, and the statuses it answers then. */
export type ImageHealthPath = { path: string; status: number[] };

const OK = [200];

/** Health paths of common self-hosted images, by repository without registry or tag. Each is read from the app's own source. */
const IMAGE_HEALTH_PATHS: { repos: string[]; path: string; status: number[] }[] = [
  { repos: ["goauthentik/server"], path: "/-/health/live/", status: OK },
  { repos: ["immich-app/immich-server", "altran1502/immich-server"], path: "/api/server/ping", status: OK },
  { repos: ["gitea/gitea", "go-gitea/gitea"], path: "/api/healthz", status: OK },
  { repos: ["binwiederhier/ntfy"], path: "/v1/health", status: OK },
  { repos: ["syncthing/syncthing", "linuxserver/syncthing"], path: "/rest/noauth/health", status: OK },
  { repos: ["amir20/dozzle"], path: "/healthcheck", status: OK },
  { repos: ["stirlingtools/stirling-pdf", "frooodle/s-pdf", "stirling-tools/stirling-pdf"], path: "/api/v1/info/status", status: OK },
  { repos: ["louislam/uptime-kuma"], path: "/api/entry-page", status: OK },
  { repos: ["linuxserver/transmission", "haugene/transmission-openvpn", "transmission/transmission"], path: "/transmission/rpc", status: [409, 401] },
  { repos: ["ollama/ollama"], path: "/api/version", status: OK },
  { repos: ["registry", "distribution/distribution"], path: "/v2/", status: [200, 401] },
];

/** The repository of an image reference: no registry host, tag, digest or `library/`. */
export function imageRepo(image: string): string {
  let ref = image.trim().toLowerCase().split("@")[0];
  const parts = ref.split("/");
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) parts.shift();
  ref = parts.join("/");
  const colon = ref.lastIndexOf(":");
  if (colon > ref.lastIndexOf("/")) ref = ref.slice(0, colon);
  return ref.startsWith("library/") ? ref.slice("library/".length) : ref;
}

/** Known health paths for these images, at most one per image, in the order given. */
export function imageHealthPaths(images: (string | null | undefined)[]): ImageHealthPath[] {
  const out: ImageHealthPath[] = [];
  for (const image of images) {
    if (!image) continue;
    const repo = imageRepo(image);
    const hit = IMAGE_HEALTH_PATHS.find((e) => e.repos.includes(repo));
    if (hit && !out.some((p) => p.path === hit.path)) out.push({ path: hit.path, status: hit.status });
  }
  return out;
}

/** How the checked path was found. */
export const HEALTH_SOURCES = ["healthcheck", "image", "probe", "homepage"] as const;
export type HealthSource = (typeof HEALTH_SOURCES)[number];

/** A body this small qualifies whatever its content type. */
export const SMALL_BODY_BYTES = 2048;
/** Bytes read from a response before hashing. */
export const HASH_BODY_BYTES = 65_536;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);
const SAFE_PATH = /^\/[A-Za-z0-9._~/-]{0,99}$/;

const unquote = (s: string) => s.replace(/^["']|["']$/g, "");

/** Splits a shell-style command on spaces, keeping quoted runs together. */
function words(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
}

function pathOfUrl(arg: string): string | null {
  const url = /^(?:https?:\/\/)?(\[[^\]]+\]|[^/:]+)?(?::\d+)?(\/[^\s]*)?$/i.exec(arg);
  if (!url) return null;
  const host = (url[1] ?? "").toLowerCase();
  const path = url[2] ?? "";
  if (/^https?:\/\//i.test(arg) ? !LOCAL_HOSTS.has(host) : host !== "" && !LOCAL_HOSTS.has(host)) return null;
  return SAFE_PATH.test(path) ? path : null;
}

/**
 * The path a healthcheck command requests from the container itself, or null.
 * Handles `["CMD", "curl", ...]`, `["CMD-SHELL", "wget ..."]`, a Dockerfile `CMD curl ...` string and plain shell strings.
 * Only localhost targets and plain paths qualify; queries, variables and anything unusual give null.
 */
export function parseHealthcheckPath(test: string | string[] | undefined | null): string | null {
  if (!test) return null;
  let command: string;
  if (Array.isArray(test)) {
    const [kind, ...rest] = test;
    if (kind === "NONE") return null;
    if (kind === "CMD") command = rest.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(" ");
    else if (kind === "CMD-SHELL") command = rest.join(" ");
    else command = test.join(" ");
  } else {
    command = test.trim().replace(/^(?:CMD-SHELL|CMD)\s+/, "");
    if (/^NONE$/i.test(command)) return null;
  }
  // Alternatives (`curl ... || wget ... || exit 1`) count when every one asks for the same path.
  const paths = command
    .split("||")
    .map((part) => part.trim())
    .filter((part) => part && !/^exit\s+\d+$/.test(part))
    .map(pathOfCommand);
  if (paths.length === 0 || paths.some((p) => p === null) || new Set(paths).size !== 1) return null;
  return paths[0];
}

function pathOfCommand(command: string): string | null {
  if (/[$`;|&<>(){}\\]/.test(command)) return null;
  const tokens = words(command);
  const tool = tokens[0]?.split("/").pop();
  if (tool !== "curl" && tool !== "wget") return null;
  // Flags that take a value, whose argument isn't the URL.
  const withValue = tool === "curl" ? new Set(["-H", "--header", "-o", "--output", "-X", "--request", "-u", "--user", "-d", "--data", "--max-time", "-m", "--retry"]) : new Set(["-O", "-T", "--timeout", "--header", "--user", "--post-data", "-t", "--tries"]);
  const found: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (withValue.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    found.push(token);
  }
  if (found.length !== 1) return null;
  return pathOfUrl(found[0]);
}

/** What a probe or the homepage answered with. */
export type Sample = {
  status: number;
  contentType: string;
  /** Bytes read, capped at HASH_BODY_BYTES. */
  bytes: number;
  /** SHA-256 of the bytes read. */
  hash: string;
  /** Vardo's catch-all answered: the host has no route. */
  noRoute?: boolean;
  /** The cache that answered instead of the origin. */
  cache?: string | null;
};

export const hashBody = (body: Uint8Array | string): string => createHash("sha256").update(body).digest("hex");

const baseType = (contentType: string) => contentType.split(";")[0].trim().toLowerCase();
const isJsonOrText = (contentType: string) => {
  const t = baseType(contentType);
  return t === "text/plain" || t === "application/json" || t.endsWith("+json");
};

/**
 * Whether a response counts as a health endpoint: 2xx, JSON or plain text or a small body, and different from the homepage
 * so a catch-all route serving the homepage everywhere doesn't qualify.
 */
export function qualifiesAsHealth(probe: Sample, homepage: Sample | null): boolean {
  if (probe.noRoute || probe.status < 200 || probe.status > 299) return false;
  if (!isJsonOrText(probe.contentType) && probe.bytes > SMALL_BODY_BYTES) return false;
  return !sameAsHomepage(probe, homepage);
}

/** Whether a known image path answered as that image does when up, and not with the homepage. */
export function qualifiesAsImageHealth(probe: Sample, homepage: Sample | null, statuses: number[]): boolean {
  if (probe.noRoute || !statuses.includes(probe.status)) return false;
  return !sameAsHomepage(probe, homepage);
}

function sameAsHomepage(probe: Sample, homepage: Sample | null): boolean {
  return !!homepage && probe.status === homepage.status && baseType(probe.contentType) === baseType(homepage.contentType) && probe.hash === homepage.hash;
}

const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|sso|auth|oauth|account\/login|session)(\/|$|\?)/i;

/** What the homepage says about the app. */
export type HomepageVerdict =
  /** Answers 2xx. */
  | { kind: "ok" }
  /** Answers below 500 but not 2xx, or redirects to a login page: ask the operator what counts as up. */
  | { kind: "review"; status: number; reason: "status" | "login" }
  /** 5xx or no answer: nothing to learn yet. */
  | { kind: "unreachable" };

/** `finalPath` is where redirects ended up. */
export function judgeHomepage(status: number | null, finalPath: string, requestedPath: string): HomepageVerdict {
  if (status === null || status >= 500) return { kind: "unreachable" };
  if (status >= 200 && status <= 299) {
    if (finalPath !== requestedPath && LOGIN_PATH.test(finalPath)) return { kind: "review", status, reason: "login" };
    return { kind: "ok" };
  }
  return { kind: "review", status, reason: "status" };
}
