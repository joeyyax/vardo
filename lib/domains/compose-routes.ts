// Hostnames an app's own Traefik router labels route, read from its compose or its running containers.

import type { ComposeFile } from "@/lib/docker/compose-types";
import { interpolate } from "@/lib/docker/compose-hosts";
import { parseRule, type RuleNode } from "@/lib/docker/traefik-rule";
import { normalizePathPrefix } from "./path-prefix";

const ROUTER_OPTION = /^traefik\.(http|tcp)\.routers\.([^.]+)\.(.+)$/i;
const SERVICE_PORT = /^traefik\.http\.services\.([^.]+)\.loadbalancer\.server\.port$/i;
const SLOT_SUFFIX = /-(blue|green)$/i;

/** Routers Vardo's file provider declares; never on a container, skipped all the same. */
const REACH_ROUTERS = new Set(["vardo-reach", "vardo-reach-http"]);

export type ComposeRoute = {
  service: string;
  /** Router name as the compose file wrote it. */
  router: string;
  host: string;
  pathPrefix: string | null;
  tls: boolean;
  certResolver: string | null;
  port: number | null;
};

export type RouteNote = { service: string; router: string; note: string };

export type RouteDiscovery = { routes: ComposeRoute[]; notes: RouteNote[] };

export type DiscoverOptions = {
  appEnv?: Record<string, string>;
  shellEnv?: Record<string, string | undefined>;
  /** True for routers Vardo wrote from its own domain rows. */
  isVardoRouter?: (router: string) => boolean;
  /** The app-id prefix Vardo namespaces tenant routers with. */
  namePrefix?: string;
  /** Labels came from a blue or green container, whose routers carry the slot. */
  slotted?: boolean;
};

type Alt = { host: string | null; path: string | null };

/** Every host-and-path combination a rule can match. Zones and regexps it can't pin go to `unread`. */
function alternatives(node: RuleNode, unread: string[]): Alt[] {
  switch (node.op) {
    case "claims":
      return node.claims.map((c): Alt => {
        if (c.kind === "host") return { host: c.host, path: null };
        if (c.kind === "any") return { host: null, path: c.path ?? null };
        if (c.kind === "zone") unread.push(`every subdomain of ${c.zone} isn't one hostname`);
        else unread.push(c.reason);
        return { host: null, path: null };
      });
    case "not":
      return [{ host: null, path: null }];
    case "or":
      return [...alternatives(node.left, unread), ...alternatives(node.right, unread)];
    case "and": {
      const out: Alt[] = [];
      for (const l of alternatives(node.left, unread)) {
        for (const r of alternatives(node.right, unread)) {
          if (l.host && r.host && l.host !== r.host) continue;
          const path = l.path && r.path ? (l.path.length >= r.path.length ? l.path : r.path) : (l.path ?? r.path);
          out.push({ host: l.host ?? r.host, path });
        }
      }
      return out;
    }
  }
}

/** Hosts and paths a rule string routes, or why it couldn't be read. */
export function hostsFromRule(rule: string): { routes: { host: string; pathPrefix: string | null }[]; unread: string[] } | { error: string } {
  let node: RuleNode;
  try {
    node = parseRule(rule);
  } catch (err) {
    return { error: `can't parse the rule: ${err instanceof Error ? err.message : String(err)}` };
  }
  const unread: string[] = [];
  const seen = new Set<string>();
  const routes: { host: string; pathPrefix: string | null }[] = [];
  for (const alt of alternatives(node, unread)) {
    if (!alt.host) continue;
    const pathPrefix = normalizePathPrefix(alt.path) ?? null;
    const key = `${alt.host}|${pathPrefix ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ host: alt.host, pathPrefix });
  }
  return { routes, unread };
}

/** The router name as written: Vardo's app-id prefix and slot suffix removed. */
function displayName(router: string, opts: DiscoverOptions): string {
  let name = opts.slotted ? router.replace(SLOT_SUFFIX, "") : router;
  if (opts.namePrefix && name.toLowerCase().startsWith(`${opts.namePrefix.toLowerCase()}-`)) {
    name = name.slice(opts.namePrefix.length + 1);
  }
  return name;
}

/** Routes one service's labels declare. */
export function routesFromLabels(
  service: string,
  labels: Record<string, string> | undefined,
  opts: DiscoverOptions = {},
): RouteDiscovery {
  const routes: ComposeRoute[] = [];
  const notes: RouteNote[] = [];
  if (!labels) return { routes, notes };

  type Router = { protocol: string; options: Map<string, string> };
  const routers = new Map<string, Router>();
  const servicePorts = new Map<string, number>();
  for (const [key, raw] of Object.entries(labels)) {
    const value = String(raw ?? "");
    const port = SERVICE_PORT.exec(key);
    if (port) {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) servicePorts.set(port[1].toLowerCase(), n);
      continue;
    }
    const m = ROUTER_OPTION.exec(key);
    if (!m) continue;
    const router = routers.get(m[2]) ?? { protocol: m[1].toLowerCase(), options: new Map() };
    router.options.set(m[3].toLowerCase(), value);
    routers.set(m[2], router);
  }

  for (const [name, router] of routers) {
    const rawRule = router.options.get("rule");
    if (!rawRule) continue;
    const base = opts.slotted ? name.replace(SLOT_SUFFIX, "") : name;
    if (REACH_ROUTERS.has(base.toLowerCase()) || opts.isVardoRouter?.(base)) continue;
    const display = displayName(name, opts);

    let rule = rawRule;
    if (rawRule.replaceAll("$$", "").includes("$")) {
      const out = interpolate(rawRule, opts.appEnv ?? {}, opts.shellEnv ?? {});
      if ("error" in out) {
        notes.push({ service, router: display, note: `skipped: ${out.error}` });
        continue;
      }
      rule = out.value;
    } else {
      rule = rawRule.replaceAll("$$", "$");
    }

    const read = hostsFromRule(rule);
    if ("error" in read) {
      notes.push({ service, router: display, note: `skipped: ${read.error}` });
      continue;
    }
    for (const reason of read.unread) notes.push({ service, router: display, note: `part of the rule skipped: ${reason}` });

    const opt = (k: string) => router.options.get(k);
    const tcp = router.protocol === "tcp";
    const tls = tcp || opt("tls") === "true" || [...router.options.keys()].some((k) => k.startsWith("tls.")) || /websecure/i.test(opt("entrypoints") ?? "");
    const certResolver = opt("tls.certresolver")?.trim() || null;
    const ref = opt("service")?.split("@")[0].toLowerCase();
    const port = tcp
      ? null
      : ref
        ? (servicePorts.get(ref) ?? servicePorts.get(ref.replace(SLOT_SUFFIX, "")) ?? null)
        : servicePorts.size === 1 ? [...servicePorts.values()][0] : null;

    for (const r of read.routes) {
      routes.push({ service, router: display, host: r.host, pathPrefix: r.pathPrefix, tls, certResolver, port });
    }
  }
  return { routes, notes };
}

/** Routes every service in a compose declares, merged by host and path. */
export function discoverComposeRoutes(compose: ComposeFile, opts: DiscoverOptions = {}): RouteDiscovery {
  const routes: ComposeRoute[] = [];
  const notes: RouteNote[] = [];
  for (const [service, svc] of Object.entries(compose.services ?? {})) {
    const found = routesFromLabels(service, svc.labels, opts);
    routes.push(...found.routes);
    notes.push(...found.notes);
  }
  return { routes: mergeRoutes(routes), notes };
}

/** One route per host and path; HTTP and HTTPS routers for the same host count once, with TLS. */
export function mergeRoutes(routes: ComposeRoute[]): ComposeRoute[] {
  const out = new Map<string, ComposeRoute>();
  for (const r of routes) {
    const key = routeKey(r.host, r.pathPrefix);
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...r });
      continue;
    }
    // The HTTPS router names the route; the HTTP one usually only redirects.
    if (r.tls && !prev.tls) out.set(key, { ...r, port: r.port ?? prev.port });
    else if (!prev.port && r.port) prev.port = r.port;
  }
  return [...out.values()];
}

export function routeKey(host: string, pathPrefix: string | null | undefined): string {
  return `${host.toLowerCase()}|${pathPrefix ?? ""}`;
}

/** Matches routers Vardo wrote for these domain rows: `<app>-<id8>` and its `-http` twin. */
export function vardoRouterMatcher(appName: string, domainIds: string[]): (router: string) => boolean {
  const names = new Set<string>();
  for (const id of domainIds) {
    const base = `${appName}-${id.slice(0, 8)}`.toLowerCase();
    names.add(base);
    names.add(`${base}-http`);
  }
  return (router) => names.has(router.toLowerCase());
}

/** Groups running containers' labels by compose service. */
export function labelsByService(containers: { labels?: Record<string, string> }[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const c of containers) {
    const service = c.labels?.["com.docker.compose.service"];
    if (!service || !c.labels) continue;
    out.set(service, { ...(out.get(service) ?? {}), ...c.labels });
  }
  return out;
}

/** Routes from running containers, for apps deployed before discovery ran at deploy time. */
export function discoverContainerRoutes(
  containers: { labels?: Record<string, string> }[],
  opts: Omit<DiscoverOptions, "slotted" | "appEnv" | "shellEnv"> = {},
): RouteDiscovery {
  const routes: ComposeRoute[] = [];
  const notes: RouteNote[] = [];
  for (const [service, labels] of labelsByService(containers)) {
    // Docker has already interpolated container labels.
    const escaped = Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, v.replaceAll("$", "$$")]));
    const found = routesFromLabels(service, escaped, { ...opts, slotted: true });
    routes.push(...found.routes);
    notes.push(...found.notes);
  }
  return { routes: mergeRoutes(routes), notes };
}
