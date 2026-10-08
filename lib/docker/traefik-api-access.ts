// Traefik's API answers only the console: a basic-auth router on the internal entrypoint, keyed from the master key (#889).

import { createHash, hkdfSync } from "crypto";
import { mkdir, rename, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { TRAEFIK_DYNAMIC_DIR } from "@/lib/paths";
import { logger } from "@/lib/logger";

const log = logger.child("traefik-api");

export const TRAEFIK_API_USER = "vardo";
// .yaml so no app's <name>.yml can replace it.
export const TRAEFIK_API_FILE = "vardo-api.yaml";

/** The API password, or null without a secret to derive it from. */
export function traefikApiPassword(): string | null {
  const secret = process.env.ENCRYPTION_MASTER_KEY || process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return Buffer.from(hkdfSync("sha256", secret, "vardo", "traefik-api", 32)).toString("hex");
}

/** Authorization header for the API, or none without a password. */
export function traefikApiHeaders(): Record<string, string> {
  const password = traefikApiPassword();
  if (!password) return {};
  return { Authorization: `Basic ${Buffer.from(`${TRAEFIK_API_USER}:${password}`).toString("base64")}` };
}

/** Dynamic config routing /api on the internal entrypoint to Traefik's API, behind basic auth. */
export function traefikApiConfig(password: string): Record<string, unknown> {
  const sha = createHash("sha1").update(password).digest("base64");
  return {
    http: {
      routers: {
        "vardo-api": {
          rule: "PathPrefix(`/api`)",
          entryPoints: ["traefik"],
          service: "api@internal",
          middlewares: ["vardo-api-auth"],
        },
      },
      middlewares: {
        "vardo-api-auth": { basicAuth: { users: [`${TRAEFIK_API_USER}:{SHA}${sha}`] } },
      },
    },
  };
}

/** Writes the API router for Traefik's file provider. Skips quietly where there's no Traefik volume. */
export async function writeTraefikApiConfig(): Promise<void> {
  const password = traefikApiPassword();
  if (!password) {
    log.warn("No ENCRYPTION_MASTER_KEY or BETTER_AUTH_SECRET; the console can't read Traefik's API");
    return;
  }
  const filePath = join(TRAEFIK_DYNAMIC_DIR, TRAEFIK_API_FILE);
  try {
    await mkdir(TRAEFIK_DYNAMIC_DIR, { recursive: true });
    await writeFile(`${filePath}.tmp`, YAML.stringify(traefikApiConfig(password)), { encoding: "utf-8", mode: 0o600 });
    await rename(`${filePath}.tmp`, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") return;
    throw err;
  }
}
