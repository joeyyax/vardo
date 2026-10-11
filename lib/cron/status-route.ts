// Serves each public cron status page at its own host: / is the page, /status.json the JSON, the rest 404s.

import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { cronStatusPages } from "@/lib/db/schema";
import { TRAEFIK_DYNAMIC_DIR } from "@/lib/paths";
import { isHostname } from "@/lib/security/hostname";
import { getDefaultCertResolver, getSslConfig } from "@/lib/system-settings";
import { STATUS_TOKEN_RE } from "./public-status";

// .yaml so no app's <name>.yml can replace it.
export const STATUS_ROUTE_FILE = "vardo-cron-status.yaml";
const PREFIX = "vardo-cron-status-";
const CONSOLE_SERVICE = "vardo@docker";
// Above an app's label routers, below the reach route and probe guard.
const PRIORITY = 10_000;

export type StatusHost = { hostname: string; token: string };

export function statusRouteConfig(hosts: StatusHost[], certResolver: string): Record<string, unknown> | null {
  const routers: Record<string, unknown> = {};
  const middlewares: Record<string, unknown> = {
    [`${PREFIX}https`]: { redirectScheme: { scheme: "https", permanent: true } },
    [`${PREFIX}not-found`]: { replacePath: { path: "/unknown-host" } },
  };

  for (const { hostname, token } of hosts) {
    const host = hostname.toLowerCase();
    if (!isHostname(host) || !STATUS_TOKEN_RE.test(token)) continue;
    const name = `${PREFIX}${host.replace(/[^a-z0-9-]/g, "-")}`;
    const h = `Host(\`${host}\`)`;
    const secure = { entryPoints: ["websecure"], service: CONSOLE_SERVICE, tls: { certResolver } };

    middlewares[`${name}-page`] = { replacePath: { path: `/status/cron/${token}` } };
    middlewares[`${name}-json`] = { replacePath: { path: `/api/status/cron/${token}` } };

    routers[`${name}-page`] = { ...secure, rule: `${h} && Path(\`/\`)`, priority: PRIORITY + 1, middlewares: [`${name}-page`] };
    routers[`${name}-json`] = { ...secure, rule: `${h} && Path(\`/status.json\`)`, priority: PRIORITY + 1, middlewares: [`${name}-json`] };
    routers[`${name}-assets`] = {
      ...secure,
      rule: `${h} && (PathPrefix(\`/_next/\`) || Path(\`/favicon.ico\`))`,
      priority: PRIORITY + 1,
    };
    routers[`${name}-other`] = { ...secure, rule: h, priority: PRIORITY, middlewares: [`${PREFIX}not-found`] };
    routers[`${name}-http`] = {
      entryPoints: ["web"],
      service: "noop@internal",
      rule: h,
      priority: PRIORITY,
      middlewares: [`${PREFIX}https`],
    };
  }

  if (Object.keys(routers).length === 0) return null;
  return { http: { routers, middlewares } };
}

function isMissingVolume(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EROFS";
}

/** Writes the routes for every enabled page with a host, or removes the file when there are none. */
export async function syncStatusRoutes(dir: string = TRAEFIK_DYNAMIC_DIR): Promise<"written" | "unchanged" | "removed" | "skipped"> {
  const rows = await db.query.cronStatusPages.findMany({
    where: and(eq(cronStatusPages.enabled, true), isNotNull(cronStatusPages.hostname)),
    columns: { hostname: true, token: true },
  });
  const hosts = rows.flatMap((r) => (r.hostname ? [{ hostname: r.hostname, token: r.token }] : []));
  const config = hosts.length > 0 ? statusRouteConfig(hosts, getDefaultCertResolver(await getSslConfig())) : null;
  const path = join(dir, STATUS_ROUTE_FILE);

  try {
    if (!config) {
      await unlink(path).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
      return "removed";
    }
    const content = `# Written by Vardo from the public cron status settings. Do not edit.\n${YAML.stringify(config, { lineWidth: 0 })}`;
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
