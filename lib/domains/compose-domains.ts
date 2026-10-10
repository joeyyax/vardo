// Stores the hosts an app's own Traefik labels route as read-only `compose` domain rows.

import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { apps, domains, environments } from "@/lib/db/schema";
import { listContainers } from "@/lib/docker/client";
import { getInstanceConfig } from "@/lib/system-settings";
import { logger } from "@/lib/logger";
import { isHostname } from "@/lib/security/hostname";
import { consoleHostsFrom } from "./ownership";
import type { ComposeFile } from "@/lib/docker/compose-types";
import { traefikNamePrefix } from "@/lib/docker/traefik-names";
import {
  discoverComposeRoutes,
  discoverContainerRoutes,
  routeKey,
  vardoRouterMatcher,
  type ComposeRoute,
} from "./compose-routes";

const log = logger.child("compose-domains");

/** The console's compose service and the port it listens on. */
const CONSOLE_SERVICE = "frontend";
const CONSOLE_PORT = 3000;

export type FamilyRow = {
  id: string;
  appId: string;
  domain: string;
  pathPrefix: string | null;
  source: "vardo" | "compose";
  composeRouter: string | null;
  serviceName: string | null;
  port: number | null;
  sslEnabled: boolean | null;
  certResolver: string | null;
};

type ComposeFields = Pick<FamilyRow, "appId" | "serviceName" | "port" | "sslEnabled" | "certResolver" | "composeRouter">;

export type ComposeDomainPlan = {
  insert: (ComposeFields & { domain: string; pathPrefix: string | null })[];
  update: { id: string; set: Partial<ComposeFields> }[];
  remove: string[];
  /** Managed rows whose compose router changed: set when a label also claims them, null once it's gone. */
  flag: { id: string; composeRouter: string | null }[];
  notes: string[];
};

/** What to write so the app's compose rows match its routes. Managed rows win a shared host. */
export function planComposeDomains(input: {
  parentAppId: string;
  childByService: Map<string, string>;
  /** Routes the running app serves. */
  routes: ComposeRoute[];
  /** Routes the compose file declares, served or not. Only flags redundant labels. */
  declared?: ComposeRoute[];
  /** Domain rows of the app and its compose children. */
  rows: FamilyRow[];
  /** host|path keys rows of other apps hold. */
  takenElsewhere: Set<string>;
}): ComposeDomainPlan {
  const managed = new Map<string, FamilyRow>();
  const existing = new Map<string, FamilyRow>();
  for (const r of input.rows) {
    (r.source === "vardo" ? managed : existing).set(routeKey(r.domain, r.pathPrefix), r);
  }

  const notes: string[] = [];
  const flagged = new Map<string, string>();
  const desired = new Map<string, ComposeRoute>();
  for (const route of input.routes) {
    const key = routeKey(route.host, route.pathPrefix);
    const owner = managed.get(key);
    if (owner) {
      if (!flagged.has(owner.id)) flagged.set(owner.id, route.router);
      continue;
    }
    if (input.takenElsewhere.has(key)) {
      notes.push(`${route.host}${route.pathPrefix ?? ""} (router ${route.router}) belongs to another app; not listed here`);
      continue;
    }
    if (!desired.has(key)) desired.set(key, route);
  }
  for (const route of input.declared ?? []) {
    const owner = managed.get(routeKey(route.host, route.pathPrefix));
    if (owner && !flagged.has(owner.id)) flagged.set(owner.id, route.router);
  }

  const fieldsOf = (route: ComposeRoute): ComposeFields => ({
    appId: input.childByService.get(route.service) ?? input.parentAppId,
    serviceName: route.service,
    port: route.port,
    sslEnabled: route.tls,
    certResolver: route.tls ? route.certResolver : null,
    composeRouter: route.router,
  });

  const plan: ComposeDomainPlan = { insert: [], update: [], remove: [], flag: [], notes };
  for (const [key, row] of existing) {
    const route = desired.get(key);
    if (!route) {
      plan.remove.push(row.id);
      continue;
    }
    desired.delete(key);
    const want = fieldsOf(route);
    const set: Partial<ComposeFields> = {};
    for (const k of Object.keys(want) as (keyof ComposeFields)[]) {
      if (row[k] !== want[k]) (set as Record<string, unknown>)[k] = want[k];
    }
    if (Object.keys(set).length > 0) plan.update.push({ id: row.id, set });
  }
  for (const route of desired.values()) {
    plan.insert.push({ ...fieldsOf(route), domain: route.host, pathPrefix: route.pathPrefix });
  }
  for (const row of managed.values()) {
    const router = flagged.get(row.id) ?? null;
    if (row.composeRouter !== router) plan.flag.push({ id: row.id, composeRouter: router });
  }
  return plan;
}

/** Replaces the compose rows of an app and its compose children. Returns the plan's notes. */
export async function syncComposeDomains(opts: {
  parentAppId: string;
  routes: ComposeRoute[];
  declared?: ComposeRoute[];
}): Promise<string[]> {
  const children = await db
    .select({ id: apps.id, composeService: apps.composeService })
    .from(apps)
    .where(eq(apps.parentAppId, opts.parentAppId));
  const childByService = new Map(children.filter((c) => c.composeService).map((c) => [c.composeService!, c.id]));
  const family = [opts.parentAppId, ...children.map((c) => c.id)];

  const rows = await db
    .select({
      id: domains.id,
      appId: domains.appId,
      domain: domains.domain,
      pathPrefix: domains.pathPrefix,
      source: domains.source,
      composeRouter: domains.composeRouter,
      serviceName: domains.serviceName,
      port: domains.port,
      sslEnabled: domains.sslEnabled,
      certResolver: domains.certResolver,
    })
    .from(domains)
    .where(inArray(domains.appId, family));

  const hosts = [...new Set(opts.routes.map((r) => r.host))];
  const elsewhere = hosts.length > 0
    ? await db
        .select({ domain: domains.domain, pathPrefix: domains.pathPrefix })
        .from(domains)
        .where(and(inArray(domains.domain, hosts), notInArray(domains.appId, family)))
    : [];

  const plan = planComposeDomains({
    parentAppId: opts.parentAppId,
    childByService,
    routes: opts.routes,
    declared: opts.declared,
    rows,
    takenElsewhere: new Set(elsewhere.map((r) => routeKey(r.domain, r.pathPrefix))),
  });

  await db.transaction(async (tx) => {
    if (plan.remove.length > 0) {
      await tx.delete(domains).where(and(inArray(domains.id, plan.remove), eq(domains.source, "compose")));
    }
    for (const u of plan.update) {
      await tx.update(domains).set(u.set).where(and(eq(domains.id, u.id), eq(domains.source, "compose")));
    }
    for (const f of plan.flag) {
      await tx.update(domains).set({ composeRouter: f.composeRouter }).where(and(eq(domains.id, f.id), eq(domains.source, "vardo")));
    }
    if (plan.insert.length > 0) {
      // Another app's deploy can take a host between the read and this write.
      await tx
        .insert(domains)
        .values(plan.insert.map((r) => ({ id: nanoid(), ...r, source: "compose" as const, isPrimary: false })))
        .onConflictDoNothing();
    }
  });
  return plan.notes;
}

/** Discovers routes in a deploy's effective compose and stores them. */
export async function syncDeployComposeDomains(input: {
  app: { id: string; name: string; domains: { id: string }[] };
  compose: ComposeFile;
  declaredCompose?: ComposeFile;
  envMap: Record<string, string>;
  log: (line: string) => void;
}): Promise<void> {
  const { app } = input;
  const opts = {
    appEnv: input.envMap,
    shellEnv: process.env,
    namePrefix: traefikNamePrefix(app.id),
    isVardoRouter: vardoRouterMatcher(app.name, app.domains.map((d) => d.id)),
  };
  const effective = discoverComposeRoutes(input.compose, opts);
  const declared = input.declaredCompose ? discoverComposeRoutes(input.declaredCompose, opts).routes : [];
  const notes = await syncComposeDomains({ parentAppId: app.id, routes: effective.routes, declared });
  for (const n of effective.notes) input.log(`[deploy] Compose domains: ${n.service} router ${n.router} ${n.note}`);
  for (const n of notes) input.log(`[deploy] Compose domains: ${n}`);
  if (effective.routes.length > 0) {
    input.log(`[deploy] Compose domains: ${effective.routes.map((r) => `${r.host}${r.pathPrefix ?? ""}`).join(", ")}`);
  }
}

/** Console hostnames as routes on Vardo's own app. */
export function consoleRoutes(hosts: string[], certResolver: string | null): ComposeRoute[] {
  return hosts
    .filter((h) => h.includes(".") && isHostname(h))
    .map((host) => ({ service: CONSOLE_SERVICE, router: "vardo", host, pathPrefix: null, tls: true, certResolver, port: CONSOLE_PORT }));
}

/** Lists the console's own hostnames on Vardo's app. */
export async function syncConsoleDomains(vardoAppId: string): Promise<void> {
  const instance = await getInstanceConfig();
  const routes = consoleRoutes(consoleHostsFrom(instance.domain), process.env.VARDO_CONSOLE_CERT_RESOLVER || "le");
  await syncComposeDomains({ parentAppId: vardoAppId, routes });
}

/** Reads routes from running containers for top-level apps that have never had compose rows written. */
export async function reconcileComposeDomains(): Promise<{ synced: number }> {
  const running = await listContainers();
  const byApp = new Map<string, typeof running>();
  for (const c of running) {
    const id = c.labels?.["vardo.project.id"];
    if (id) byApp.set(id, [...(byApp.get(id) ?? []), c]);
  }
  if (byApp.size === 0) return { synced: 0 };

  const candidates = await db
    .select({ id: apps.id, name: apps.name })
    .from(apps)
    .where(and(inArray(apps.id, [...byApp.keys()]), eq(apps.isSystemManaged, false), isNull(apps.parentAppId)));

  let synced = 0;
  for (const app of candidates) {
    try {
      const children = await db.select({ id: apps.id }).from(apps).where(eq(apps.parentAppId, app.id));
      const family = [app.id, ...children.map((c) => c.id)];
      const rows = await db
        .select({ id: domains.id, source: domains.source })
        .from(domains)
        .where(inArray(domains.appId, family));
      if (rows.some((r) => r.source === "compose")) continue;

      const [env] = await db
        .select({ name: environments.name })
        .from(environments)
        .where(and(eq(environments.appId, app.id), or(eq(environments.isDefault, true), eq(environments.type, "production"))))
        .limit(1);
      const envName = env?.name ?? "production";
      const containers = byApp.get(app.id)!.filter((c) => (c.labels?.["vardo.environment"] ?? envName) === envName);

      const found = discoverContainerRoutes(containers, {
        namePrefix: app.id,
        isVardoRouter: vardoRouterMatcher(app.name, rows.map((r) => r.id)),
      });
      // Nothing running routes a host: leave the rows to the next deploy.
      if (found.routes.length === 0) continue;
      const notes = await syncComposeDomains({ parentAppId: app.id, routes: found.routes });
      for (const n of [...notes, ...found.notes.map((n) => `${n.service} ${n.router}: ${n.note}`)]) log.info(`${app.name}: ${n}`);
      synced++;
    } catch (err) {
      log.warn(`${app.name}: compose domain reconcile failed:`, err);
    }
  }
  return { synced };
}
