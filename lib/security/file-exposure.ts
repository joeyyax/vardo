import pLimit from "p-limit";
import { logger } from "@/lib/logger";

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
  { path: "/.svn/entries" },
  { path: "/backup.sql", heuristic: (b) => b.includes("INSERT INTO") || b.includes("CREATE TABLE") },
  { path: "/dump.sql", heuristic: (b) => b.includes("INSERT INTO") || b.includes("CREATE TABLE") },
  { path: "/.npmrc", heuristic: (b) => b.includes("registry") || b.includes("//") },
  { path: "/.docker/config.json", heuristic: (b) => b.includes("auths") },
  { path: "/config.yml", heuristic: (b) => b.includes(":") },
];

const TIMEOUT_MS = 3_000;
const CONCURRENCY = 5;

/**
 * Probe a deployed domain for commonly exposed sensitive files.
 * Returns an array of paths that appear to be publicly accessible.
 */
export async function checkFileExposure(domain: string): Promise<string[]> {
  const limit = pLimit(CONCURRENCY);
  const exposed: string[] = [];

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

        const body = await res.text();

        if (heuristic) {
          if (heuristic(body)) {
            exposed.push(path);
            log.warn(`Exposed file detected: https://${domain}${path}`);
          }
        } else if (body.length > 0) {
          exposed.push(path);
          log.warn(`Exposed file detected: https://${domain}${path}`);
        }
      } catch {
        // Timeout or network error — not exposed
      }
    }),
  );

  await Promise.all(tasks);
  return exposed;
}
