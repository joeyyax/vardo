// The probe guard as one Traefik file-provider file: high-priority routers that send probes, traps, canaries and banned clients to the console's responder.

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { TRAEFIK_DYNAMIC_DIR } from "@/lib/paths";
import { isHostname } from "@/lib/security/hostname";
import { parseRule } from "@/lib/docker/traefik-rule";
import { activeRules, exceptionClause, exceptionProblem, probePathRegexp } from "./rules";
import { CANARY_HEADERS, CANARY_QUERY_KEYS, MARKER_RE, canaryRegexp } from "./canary";
import { normalizeIp } from "./ban-policy";

// .yaml so no app's <name>.yml can replace it.
export const GUARD_FILE = "vardo-probe-guard.yaml";
export const GUARD_PREFIX = "vardo-guard-";
export const KEY_HEADER = "X-Vardo-Guard";
export const APP_HEADER = "X-Vardo-Guard-App";
export const RESPONDER_PATH = "/probe-guard";
export const RESPONDER_SERVICE = "vardo-guard-responder";
// The console's own router service, from its compose labels.
export const CONSOLE_SERVICE = "vardo@docker";

export const GUARD_KINDS = ["banned", "canary", "trap", "probe", "robots"] as const;
export type GuardKind = (typeof GUARD_KINDS)[number];

// Above anything an app's labels set.
export const PRIORITY: Record<GuardKind, number> = {
  banned: 1_000_000_040,
  canary: 1_000_000_030,
  trap: 1_000_000_020,
  probe: 1_000_000_010,
  robots: 1_000_000_000,
};

// Keeps the rule well under what Traefik parses quickly.
export const MAX_RENDERED_BANS = 1000;
export const MAX_RENDERED_MARKERS = 50;

const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[a-f0-9]{32,128}$/;

export type GuardApp = {
  id: string;
  hosts: string[];
  exceptions: string[];
  wordpress: boolean;
  robotsTxt: boolean;
  /** The console's own host: traps and probes only, never the ban router. */
  console?: boolean;
};

export type GuardState = {
  key: string;
  apps: GuardApp[];
  bannedIps: string[];
  trapPaths: string[];
  markers: string[];
  /** Points the responder at a URL instead of the console's docker service. */
  responderUrl?: string | null;
};

const ENTRYPOINTS = [
  { suffix: "web", entryPoints: ["web"], tls: false },
  { suffix: "websecure", entryPoints: ["websecure"], tls: true },
] as const;

function hostMatcher(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (h.startsWith("*.")) {
    const zone = h.slice(2);
    return isHostname(zone) ? `HostRegexp(\`^[^.]+\\.${zone.replace(/\./g, "\\.")}$\`)` : null;
  }
  return isHostname(h) ? `Host(\`${h}\`)` : null;
}

function hostClause(hosts: readonly string[]): string | null {
  const parts = [...new Set(hosts.map(hostMatcher).filter((m): m is string => !!m))];
  return parts.length > 0 ? `(${parts.join(" || ")})` : null;
}

function escapeIp(ip: string): string {
  return ip.replace(/\./g, "\\.");
}

/** Matches a banned address directly, in X-Forwarded-For from a trusted proxy, or in CF-Connecting-IP. */
export function banClause(ips: readonly string[]): string | null {
  const list = [...new Set(ips.map(normalizeIp).filter((ip): ip is string => !!ip))].slice(0, MAX_RENDERED_BANS);
  if (list.length === 0) return null;
  const alt = list.map(escapeIp).join("|");
  const direct = list.map((ip) => `ClientIP(\`${ip}\`)`);
  return `(${[
    ...direct,
    `HeaderRegexp(\`X-Forwarded-For\`, \`(?:^|[\\s,])(?:${alt})(?:$|[\\s,])\`)`,
    `HeaderRegexp(\`Cf-Connecting-Ip\`, \`^\\s*(?:${alt})\\s*$\`)`,
  ].join(" || ")})`;
}

/** Matches a request that carries a canary marker in a credential header or query parameter. */
export function canaryClause(markers: readonly string[]): string | null {
  const valid = markers.filter((m) => MARKER_RE.test(m)).slice(0, MAX_RENDERED_MARKERS);
  if (valid.length === 0) return null;
  const re = `(?i)${canaryRegexp(valid)}`;
  return `(${[
    ...CANARY_HEADERS.map((h) => `HeaderRegexp(\`${h}\`, \`${re}\`)`),
    ...CANARY_QUERY_KEYS.map((k) => `QueryRegexp(\`${k}\`, \`${re}\`)`),
  ].join(" || ")})`;
}

export function trapClause(paths: readonly string[]): string | null {
  const valid = paths.filter((p) => !exceptionProblem(p));
  if (valid.length === 0) return null;
  return `(${valid.map((p) => (p.endsWith("/") ? `PathPrefix(\`${p}\`)` : `Path(\`${p}\`)`)).join(" || ")})`;
}

function withExceptions(rule: string, exceptions: readonly string[]): string {
  const valid = exceptions.filter((e) => !exceptionProblem(e));
  return valid.length > 0 ? `${rule} && ${exceptionClause(valid)}` : rule;
}

type Router = {
  entryPoints: string[];
  rule: string;
  priority: number;
  service: string;
  middlewares: string[];
  tls?: Record<string, never>;
};

/** The file's config object. */
export function renderGuardConfig(state: GuardState): Record<string, unknown> {
  if (!KEY_RE.test(state.key)) throw new Error("Probe guard key is malformed");
  const routers: Record<string, Router> = {};
  const middlewares: Record<string, unknown> = {
    [`${GUARD_PREFIX}tag`]: { headers: { customRequestHeaders: { [KEY_HEADER]: state.key, [APP_HEADER]: "" } } },
  };
  for (const kind of GUARD_KINDS) {
    middlewares[`${GUARD_PREFIX}to-${kind}`] = { replacePath: { path: `${RESPONDER_PATH}/${kind}` } };
  }
  const service = state.responderUrl ? RESPONDER_SERVICE : CONSOLE_SERVICE;

  const add = (name: string, kind: GuardKind, rule: string, tag: string) => {
    for (const ep of ENTRYPOINTS) {
      routers[`${name}-${ep.suffix}`] = {
        entryPoints: [...ep.entryPoints],
        rule,
        priority: PRIORITY[kind],
        service,
        middlewares: [tag, `${GUARD_PREFIX}to-${kind}`],
        ...(ep.tls ? { tls: {} } : {}),
      };
    }
  };

  const apps = state.apps.filter((a) => APP_ID_RE.test(a.id));
  const allHosts = hostClause(apps.filter((a) => !a.console).flatMap((a) => a.hosts));
  if (allHosts) {
    const bans = banClause(state.bannedIps);
    if (bans) add(`${GUARD_PREFIX}banned`, "banned", `${allHosts} && ${bans}`, `${GUARD_PREFIX}tag`);
    const canary = canaryClause(state.markers);
    if (canary) add(`${GUARD_PREFIX}canary`, "canary", `${allHosts} && ${canary}`, `${GUARD_PREFIX}tag`);
  }

  const traps = trapClause(state.trapPaths);
  for (const app of apps) {
    const hosts = hostClause(app.hosts);
    if (!hosts) continue;
    const tag = app.console ? `${GUARD_PREFIX}tag` : `${GUARD_PREFIX}${app.id}-tag`;
    if (!app.console) middlewares[tag] = { headers: { customRequestHeaders: { [KEY_HEADER]: state.key, [APP_HEADER]: app.id } } };
    if (traps) add(`${GUARD_PREFIX}${app.id}-trap`, "trap", withExceptions(`${hosts} && ${traps}`, app.exceptions), tag);
    const probe = `${hosts} && PathRegexp(\`${probePathRegexp(activeRules({ wordpress: app.wordpress }))}\`)`;
    add(`${GUARD_PREFIX}${app.id}-probe`, "probe", withExceptions(probe, app.exceptions), tag);
    if (app.robotsTxt) add(`${GUARD_PREFIX}${app.id}-robots`, "robots", `${hosts} && Path(\`/robots.txt\`)`, tag);
  }

  const http: Record<string, unknown> = { middlewares };
  if (Object.keys(routers).length > 0) http.routers = routers;
  if (state.responderUrl) http.services = { [RESPONDER_SERVICE]: { loadBalancer: { servers: [{ url: state.responderUrl }] } } };
  return { http };
}

export function renderGuardFile(state: GuardState): string {
  return `# Written by Vardo from the probe guard settings and bans. Do not edit.\n${YAML.stringify(renderGuardConfig(state), { lineWidth: 0 })}`;
}

/** Whether a rendered file holds only the guard's own routers, middlewares and service. A bad file stops Traefik loading every file. */
export function isValidGuardFile(content: string): boolean {
  try {
    const parsed = YAML.parse(content) as { http?: Record<string, Record<string, Record<string, unknown>>> };
    if (!parsed || Object.keys(parsed).length !== 1 || !parsed.http) return false;
    const { routers = {}, middlewares, services } = parsed.http;
    if (Object.keys(parsed.http).some((k) => !["routers", "middlewares", "services"].includes(k))) return false;
    if (!middlewares || !Object.keys(middlewares).every((n) => n.startsWith(GUARD_PREFIX))) return false;
    for (const def of Object.values(middlewares)) {
      const kinds = Object.keys(def);
      if (kinds.length !== 1) return false;
      if (kinds[0] === "replacePath") {
        const path = (def.replacePath as { path?: unknown }).path;
        if (typeof path !== "string" || !path.startsWith(`${RESPONDER_PATH}/`)) return false;
      } else if (kinds[0] === "headers") {
        const custom = (def.headers as { customRequestHeaders?: Record<string, unknown> }).customRequestHeaders;
        if (!custom || Object.keys(def.headers as object).length !== 1) return false;
        if (typeof custom[KEY_HEADER] !== "string" || !KEY_RE.test(custom[KEY_HEADER] as string)) return false;
      } else {
        return false;
      }
    }
    const serviceNames = Object.keys(services ?? {});
    if (serviceNames.some((n) => n !== RESPONDER_SERVICE)) return false;
    for (const [name, r] of Object.entries(routers)) {
      if (!name.startsWith(GUARD_PREFIX)) return false;
      const router = r as Partial<Router>;
      if (router.service !== CONSOLE_SERVICE && !(router.service === RESPONDER_SERVICE && serviceNames.length === 1)) return false;
      if (!router.entryPoints?.every((e) => e === "web" || e === "websecure")) return false;
      if (!router.middlewares?.length || !router.middlewares.every((m) => m in middlewares)) return false;
      if (typeof router.rule !== "string" || typeof router.priority !== "number") return false;
      parseRule(router.rule);
    }
    return true;
  } catch {
    return false;
  }
}

function isMissingVolume(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EROFS";
}

/** Writes the file for Traefik to reload. "skipped" where there's no Traefik volume. */
export async function writeGuardFile(
  state: GuardState,
  dir: string = TRAEFIK_DYNAMIC_DIR,
): Promise<"written" | "unchanged" | "skipped"> {
  const path = join(dir, GUARD_FILE);
  const content = renderGuardFile(state);
  if (!isValidGuardFile(content)) throw new Error("Rendered probe guard file did not validate");
  try {
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
