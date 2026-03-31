import pLimit from "p-limit";
import { logger } from "@/lib/logger";
import { assertPublicDomain } from "./validate-domain";
import type { SecurityFinding } from "./types";

const log = logger.child("security");

/**
 * Paths to probe for sensitive file exposure after deploy.
 * Each entry optionally includes a content heuristic — if provided,
 * the response body must match for the path to count as exposed.
 */
const PROBE_PATHS: { path: string; heuristic?: (body: string) => boolean }[] = [
  { path: "/.env", heuristic: (b) => b.includes("=") },
  { path: "/.git/config", heuristic: (b) => b.includes("[core]") },
  { path: "/.git/HEAD", heuristic: (b) => b.startsWith("ref:") || /^[0-9a-f]{40}/.test(b) },
  { path: "/wp-config.php", heuristic: (b) => b.includes("DB_NAME") || b.includes("DB_PASSWORD") },
  { path: "/.htaccess", heuristic: (b) => b.includes("RewriteEngine") || b.includes("Deny") },
  { path: "/.DS_Store", heuristic: (b) => b.startsWith("\x00\x00\x00\x01Bud1") || b.length > 0 },
  { path: "/server.key" },
  { path: "/.ssh/id_rsa", heuristic: (b) => b.includes("PRIVATE KEY") },
  { path: "/phpinfo.php", heuristic: (b) => b.includes("phpinfo()") || b.includes("PHP Version") },
  { path: "/server-status", heuristic: (b) => b.includes("Apache") || b.includes("Server Status") },
  { path: "/debug.log", heuristic: (b) => b.length > 0 },
  { path: "/.svn/entries" },
  { path: "/backup.sql", heuristic: (b) => b.includes("INSERT INTO") || b.includes("CREATE TABLE") },
  { path: "/dump.sql", heuristic: (b) => b.includes("INSERT INTO") || b.includes("CREATE TABLE") },
  { path: "/.npmrc", heuristic: (b) => b.includes("registry") || b.includes("//") },
  { path: "/.docker/config.json", heuristic: (b) => b.includes("auths") },
  // Match YAML key-value lines (word-char key followed by colon+space or colon+newline)
  // to avoid matching every HTML/JSON/XML response.
  { path: "/config.yml", heuristic: (b) => /^[\w-]+\s*:/m.test(b) },
];

/** Paths that are critical (private keys, credentials) vs warning-level */
const CRITICAL_PATHS = new Set(["/.env", "/.git/config", "/.git/HEAD", "/server.key", "/.ssh/id_rsa", "/wp-config.php"]);

const TIMEOUT_MS = 3_000;
const CONCURRENCY = 5;

/** Maximum response body size to read — guards against large/slow responses. */
const MAX_BODY_BYTES = 64 * 1024; // 64 KB

/**
 * Probe a deployed domain for commonly exposed sensitive files.
 * Returns SecurityFinding[] for each exposed path found.
 */
export async function checkFileExposure(domain: string): Promise<SecurityFinding[]> {
  await assertPublicDomain(domain);

  const limit = pLimit(CONCURRENCY);
  const findings: SecurityFinding[] = [];

  const tasks = PROBE_PATHS.map(({ path, heuristic }) =>
    limit(async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const res = await fetch(`https://${domain}${path}`, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (res.status !== 200) return;

        // Read response body with a hard size cap to prevent unbounded memory use.
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength === 0) return;

        const slice = buffer.byteLength > MAX_BODY_BYTES
          ? buffer.slice(0, MAX_BODY_BYTES)
          : buffer;
        const body = new TextDecoder().decode(slice);

        const isExposed = heuristic ? heuristic(body) : true;
        if (!isExposed) return;

        log.warn(`Exposed file detected: https://${domain}${path}`);
        findings.push({
          type: "file-exposure",
          severity: CRITICAL_PATHS.has(path) ? "critical" : "warning",
          title: `Sensitive file exposed: ${path}`,
          description: `The file at ${path} is publicly accessible. This may expose credentials or server internals.`,
          detail: path,
        });
      } catch {
        // Timeout or network error — not exposed
      }
    }),
  );

  await Promise.all(tasks);
  return findings;
}
