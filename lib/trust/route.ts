// Serves /trust and /trust/dpa.pdf on the chosen domain with Traefik replacePath. Every other path on that host stays with its app.

import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { TRAEFIK_DYNAMIC_DIR } from "@/lib/paths";
import { isHostname } from "@/lib/security/hostname";
import { getDefaultCertResolver, getSslConfig } from "@/lib/system-settings";
import { getTrustSettings } from "./store";

// .yaml so no app's <name>.yml can replace it.
export const TRUST_ROUTE_FILE = "vardo-trust.yaml";
const PREFIX = "vardo-trust-";
const CONSOLE_SERVICE = "vardo@docker";
// Above an app's label routers, same band as the cron status routes.
const PRIORITY = 10_001;

export const TRUST_PATH = "/trust";
export const TRUST_DPA_PATH = "/trust/dpa.pdf";
export const TRUST_PAGE_TARGET = "/api/public/trust";
export const TRUST_DPA_TARGET = "/api/public/trust/dpa";

export function trustRouteConfig(domain: string, certResolver: string): Record<string, unknown> | null {
  const host = domain.toLowerCase();
  if (!isHostname(host)) return null;
  const secure = { entryPoints: ["websecure"], service: CONSOLE_SERVICE, tls: { certResolver }, priority: PRIORITY };
  const h = `Host(\`${host}\`)`;
  return {
    http: {
      routers: {
        [`${PREFIX}page`]: { ...secure, rule: `${h} && Path(\`${TRUST_PATH}\`)`, middlewares: [`${PREFIX}page`] },
        [`${PREFIX}dpa`]: { ...secure, rule: `${h} && Path(\`${TRUST_DPA_PATH}\`)`, middlewares: [`${PREFIX}dpa`] },
      },
      middlewares: {
        [`${PREFIX}page`]: { replacePath: { path: TRUST_PAGE_TARGET } },
        [`${PREFIX}dpa`]: { replacePath: { path: TRUST_DPA_TARGET } },
      },
    },
  };
}

function isMissingVolume(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EROFS";
}

/** Writes the routes while the page is public, or removes the file. */
export async function syncTrustRoutes(dir: string = TRAEFIK_DYNAMIC_DIR): Promise<"written" | "unchanged" | "removed" | "skipped"> {
  const settings = await getTrustSettings();
  const config =
    settings.visibility === "public" && settings.domain
      ? trustRouteConfig(settings.domain, getDefaultCertResolver(await getSslConfig()))
      : null;
  const path = join(dir, TRUST_ROUTE_FILE);
  try {
    if (!config) {
      await unlink(path).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
      return "removed";
    }
    const content = `# Written by Vardo from the trust center settings. Do not edit.\n${YAML.stringify(config, { lineWidth: 0 })}`;
    if ((await readFile(path, "utf-8").catch(() => null)) === content) return "unchanged";
    await mkdir(dir, { recursive: true });
    await writeFile(`${path}.tmp`, content, { encoding: "utf-8", mode: 0o644 });
    await rename(`${path}.tmp`, path);
    return "written";
  } catch (err) {
    if (isMissingVolume(err)) return "skipped";
    throw err;
  }
}
