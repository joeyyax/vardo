// VARDO_CONSOLE_MIDDLEWARES locks the console's routers (docker-compose.yml). This writes the unlocked
// router for the paths that must stay reachable: the health check and the GitHub and Pouch webhooks.

import { mkdir, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { TRAEFIK_DYNAMIC_DIR } from "@/lib/paths";
import { isHostname } from "@/lib/security/hostname";
import { middlewareProblem, parseMiddlewares } from "@/lib/domains/middlewares";
import { logger } from "@/lib/logger";

const log = logger.child("console-lock");

// .yaml so no app's <name>.yml can replace it.
export const CONSOLE_PUBLIC_FILE = "vardo-console-public.yaml";

export const CONSOLE_PUBLIC_PATHS = ["/api/health", "/api/v1/github/webhook", "/api/v1/email/pouch/webhook"] as const;

// Above every route Vardo writes for an app, so the console's own paths win on its host.
const PUBLIC_PRIORITY = 100_000;

type Env = Record<string, string | undefined>;

/** The lock's middlewares, and any that can't be valid Traefik references. */
export function consoleLock(env: Env = process.env): { middlewares: string[]; invalid: string[] } {
  const middlewares = parseMiddlewares(env.VARDO_CONSOLE_MIDDLEWARES);
  return { middlewares, invalid: middlewares.filter((m) => middlewareProblem(m, true)) };
}

/** The unlocked router, or null without a lock or a console domain. */
export function consolePublicConfig(env: Env = process.env): Record<string, unknown> | null {
  const domain = env.VARDO_DOMAIN?.trim().toLowerCase();
  if (consoleLock(env).middlewares.length === 0 || !domain || !isHostname(domain) || domain === "localhost") return null;
  const paths = CONSOLE_PUBLIC_PATHS.map((p) => `Path(\`${p}\`)`).join(" || ");
  return {
    http: {
      routers: {
        "vardo-console-public": {
          rule: `Host(\`${domain}\`) && (${paths})`,
          entryPoints: ["websecure"],
          service: "vardo@docker",
          priority: PUBLIC_PRIORITY,
          tls: { certResolver: env.VARDO_CONSOLE_CERT_RESOLVER?.trim() || "le" },
        },
      },
    },
  };
}

/** Writes or removes the unlocked router to match the environment. */
export async function syncConsolePublicRoute(opts: { dir?: string; env?: Env } = {}): Promise<"written" | "removed" | "skipped"> {
  const env = opts.env ?? process.env;
  const path = join(opts.dir ?? TRAEFIK_DYNAMIC_DIR, CONSOLE_PUBLIC_FILE);
  const { middlewares, invalid } = consoleLock(env);
  if (invalid.length > 0) {
    log.error(`VARDO_CONSOLE_MIDDLEWARES has invalid entries (${invalid.join(", ")}); Traefik will refuse the console's routers`);
  }
  const config = consolePublicConfig(env);
  try {
    if (!config) {
      if (middlewares.length > 0) log.warn("VARDO_CONSOLE_MIDDLEWARES is set without VARDO_DOMAIN; the health check and webhook stay locked");
      await unlink(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
      return "removed";
    }
    await mkdir(opts.dir ?? TRAEFIK_DYNAMIC_DIR, { recursive: true });
    await writeFile(`${path}.tmp`, YAML.stringify(config), { encoding: "utf-8", mode: 0o644 });
    await rename(`${path}.tmp`, path);
    log.info(`Console locked with ${middlewares.join(", ")}; ${CONSOLE_PUBLIC_PATHS.join(", ")} stay public`);
    return "written";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") return "skipped";
    throw err;
  }
}
