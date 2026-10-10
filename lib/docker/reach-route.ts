// Routes /.well-known/vardo/ on every host to the console, so dns-check can prove a domain reaches it.

import { mkdir, rename, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { TRAEFIK_DYNAMIC_DIR } from "@/lib/paths";
import { REACH_PATH } from "@/lib/domains/reach";

// .yaml so no app's <name>.yml can replace it.
export const REACH_ROUTE_FILE = "vardo-reach.yaml";

// Above every app route. Traefik's own ACME router outranks it and owns a different prefix.
const REACH_PRIORITY = 100_000;

/** Both entrypoints, unlocked, to the console's label-declared service that every slot keeps. */
export function reachRouteConfig(): Record<string, unknown> {
  const rule = `PathPrefix(\`${REACH_PATH}\`)`;
  return {
    http: {
      routers: {
        "vardo-reach": { rule, entryPoints: ["websecure"], service: "vardo@docker", priority: REACH_PRIORITY, tls: {} },
        "vardo-reach-http": { rule, entryPoints: ["web"], service: "vardo@docker", priority: REACH_PRIORITY },
      },
    },
  };
}

/** Writes the route for Traefik's file provider. Skips quietly where there's no Traefik volume. */
export async function writeReachRoute(dir: string = TRAEFIK_DYNAMIC_DIR): Promise<"written" | "skipped"> {
  const path = join(dir, REACH_ROUTE_FILE);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(`${path}.tmp`, YAML.stringify(reachRouteConfig()), { encoding: "utf-8", mode: 0o644 });
    await rename(`${path}.tmp`, path);
    return "written";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EROFS") return "skipped";
    throw err;
  }
}
