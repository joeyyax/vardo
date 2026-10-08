import pLimit from "p-limit";
import { logger } from "@/lib/logger";
import { assertPublicDomain } from "./validate-domain";
import { safeFetch } from "./safe-fetch";
import { getDomainProbePolicy } from "./outbound-policy";
import type { SecurityFinding } from "./types";

const log = logger.child("security");

/** Paths to probe after deploy. A heuristic, when set, must match the body to count as exposed. */
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
  // YAML key-value lines only, not any HTML/JSON/XML response.
  { path: "/config.yml", heuristic: (b) => /^[\w-]+\s*:/m.test(b) },
];

/** Critical paths; the rest are warnings. */
const CRITICAL_PATHS = new Set(["/.env", "/.git/config", "/.git/HEAD", "/server.key", "/.ssh/id_rsa", "/wp-config.php"]);

const TIMEOUT_MS = 3_000;
const CONCURRENCY = 5;

const MAX_BODY_BYTES = 64 * 1024;

/** Probes a deployed domain for commonly exposed sensitive files. */
export async function checkFileExposure(domain: string): Promise<SecurityFinding[]> {
  await assertPublicDomain(domain);

  const limit = pLimit(CONCURRENCY);
  const policy = await getDomainProbePolicy();
  const findings: SecurityFinding[] = [];

  const tasks = PROBE_PATHS.map(({ path, heuristic }) =>
    limit(async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        // A redirect throws here, which counts as not exposed.
        const res = await safeFetch(`https://${domain}${path}`, {
          method: "GET",
          maxRedirects: 0,
          signal: controller.signal,
          policy,
        });

        clearTimeout(timer);

        if (res.status !== 200) return;

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
        // Timeout or network error: not exposed.
      }
    }),
  );

  await Promise.all(tasks);
  return findings;
}
