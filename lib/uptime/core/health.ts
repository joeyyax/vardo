// Health endpoint detection: reading a path out of a container healthcheck, deciding which responses qualify, and judging the homepage.

import { createHash } from "node:crypto";

/** Paths tried, in order, when the app's own healthcheck names none. */
export const HEALTH_PATHS = ["/healthz", "/health", "/api/health", "/up", "/livez", "/readyz", "/ping", "/status", "/_health"] as const;

/** How the checked path was found. */
export const HEALTH_SOURCES = ["healthcheck", "probe", "homepage"] as const;
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
  if (probe.status < 200 || probe.status > 299) return false;
  if (!isJsonOrText(probe.contentType) && probe.bytes > SMALL_BODY_BYTES) return false;
  if (homepage && probe.status === homepage.status && baseType(probe.contentType) === baseType(homepage.contentType) && probe.hash === homepage.hash) return false;
  return true;
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
