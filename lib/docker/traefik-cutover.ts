// ---------------------------------------------------------------------------
// Traefik cutover pin
//
// Traefik's Docker provider addresses a slot by container IP and only re-reads
// the container list when it reconciles. A container that has already exited
// keeps its place in the load balancer until then, and a request sent to a
// departed IP hangs until the client gives up — it is never refused.
//
// This publishes a short-lived file-provider route that mirrors the app's
// Docker routers, outranks them by one, and names the new slot's container
// instead of an IP. Traffic leaves the old slot before it is stopped. The file
// is removed once Traefik's Docker view no longer holds the old slot's
// addresses, which hands routing back to the labels.
// ---------------------------------------------------------------------------

import { mkdir, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";

import { TRAEFIK_DYNAMIC_DIR } from "@/lib/paths";
import type { ComposeFile, ComposeService } from "./compose-types";
import {
  collectDockerBackends,
  fetchTraefikRouters,
  fetchTraefikServices,
  liveContainers,
} from "./traefik-api";

/** How long to wait for Traefik to publish the pin before giving up on it. */
export const PIN_CONFIRM_TIMEOUT = 10_000;
/** How long to wait for Traefik to drop the stopped slot before unpinning. */
export const PIN_RELEASE_TIMEOUT = 20_000;
const POLL_INTERVAL = 250;

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

type Labels = Record<string, string>;

type RouterOptions = { composeService: string; opts: Labels };

export type CutoverPlan = {
  /** File-provider router names, without the `@file` suffix. */
  routerNames: string[];
  yaml: string;
};

type PinRouter = {
  rule: string;
  service: string;
  priority: number;
  entryPoints?: string[];
  middlewares?: string[];
  tls?: { certResolver?: string };
};

type PinService = {
  loadBalancer: { servers: { url: string }[]; serversTransport?: string };
};

const ROUTER_LABEL = /^traefik\.http\.routers\.([^.]+)\.(.+)$/;
const SERVICE_LABEL = /^traefik\.http\.services\.([^.]+)\.(.+)$/;

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

/**
 * Traefik defaults a router's priority to the length of its rule, so adding one
 * beats the Docker twin without reordering the router against anything else.
 */
function pinPriority(opts: Labels, rule: string): number {
  const declared = Number(opts["priority"]);
  return (Number.isFinite(declared) && declared > 0 ? declared : rule.length) + 1;
}

/**
 * Mirror the app's Docker routing as a file-provider config aimed at the new
 * slot's containers. Returns null when nothing routable was found — an app with
 * no domains, or one that routes itself.
 */
export function planCutover(
  compose: ComposeFile,
  opts: {
    /** Compose project of the slot that must receive the traffic. */
    newProjectName: string;
    /** Services that rotate. A shared service is never replaced, so never pinned. */
    slotted: Record<string, ComposeService>;
  },
): CutoverPlan | null {
  const routers = new Map<string, RouterOptions>();
  const declared = new Map<string, RouterOptions>();

  for (const name of Object.keys(opts.slotted)) {
    const labels = compose.services[name]?.labels;
    if (!labels || labels["traefik.enable"] !== "true") continue;

    for (const [key, value] of Object.entries(labels)) {
      const router = ROUTER_LABEL.exec(key);
      if (router) {
        const entry = routers.get(router[1]) ?? { composeService: name, opts: {} };
        entry.opts[router[2].toLowerCase()] = value;
        routers.set(router[1], entry);
        continue;
      }
      const service = SERVICE_LABEL.exec(key);
      if (service) {
        const entry = declared.get(service[1]) ?? { composeService: name, opts: {} };
        entry.opts[service[2].toLowerCase()] = value;
        declared.set(service[1], entry);
      }
    }
  }

  const pinRouters: Record<string, PinRouter> = {};
  const pinServices: Record<string, PinService> = {};
  const transports: Record<string, { insecureSkipVerify: boolean }> = {};

  for (const [routerName, router] of routers) {
    const rule = router.opts["rule"];
    const target = router.opts["service"];
    if (!rule || !target) continue;

    const backend = declared.get(target);
    const port = backend?.opts["loadbalancer.server.port"];
    // A router pointing at a service no service declares is left on the Docker
    // provider, where it behaves exactly as it did before.
    if (!backend || !port) continue;

    const pinName = `${target}-cutover`;
    if (!pinServices[pinName]) {
      const scheme = backend.opts["loadbalancer.server.scheme"] === "https" ? "https" : "http";
      const container = `${opts.newProjectName}-${backend.composeService}-1`;
      pinServices[pinName] = {
        loadBalancer: {
          servers: [{ url: `${scheme}://${container}:${port}` }],
          ...(scheme === "https" ? { serversTransport: `${pinName}-insecure` } : {}),
        },
      };
      if (scheme === "https") transports[`${pinName}-insecure`] = { insecureSkipVerify: true };
    }

    const entryPoints = splitList(router.opts["entrypoints"]);
    const middlewares = splitList(router.opts["middlewares"]).map((m) =>
      m.includes("@") ? m : `${m}@docker`,
    );
    const certResolver = router.opts["tls.certresolver"];
    const tls = certResolver ? { certResolver } : router.opts["tls"] === "true" ? {} : undefined;

    pinRouters[`${routerName}-cutover`] = {
      rule,
      service: pinName,
      priority: pinPriority(router.opts, rule),
      // Omitted rather than defaulted: no entrypoint label means every entrypoint.
      ...(entryPoints.length > 0 ? { entryPoints } : {}),
      ...(middlewares.length > 0 ? { middlewares } : {}),
      ...(tls ? { tls } : {}),
    };
  }

  const routerNames = Object.keys(pinRouters);
  if (routerNames.length === 0) return null;

  return {
    routerNames,
    yaml: YAML.stringify({
      http: {
        routers: pinRouters,
        services: pinServices,
        ...(Object.keys(transports).length > 0 ? { serversTransports: transports } : {}),
      },
    }),
  };
}

/** Whether every pinned router is live in Traefik. */
export function pinIsLive(
  routers: { name?: string; status?: string }[],
  names: string[],
): boolean {
  const enabled = new Set(
    routers.filter((r) => r.status === "enabled").map((r) => (r.name ?? "").split("@")[0]),
  );
  return names.every((name) => enabled.has(name));
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export function cutoverPinPath(appName: string, envName: string): string {
  return join(TRAEFIK_DYNAMIC_DIR, `cutover-${appName}-${envName}.yml`);
}

/** Missing or unwritable Traefik volume — nothing to route through, and not an error. */
function isMissingVolume(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? err.code : null;
  return code === "ENOENT" || code === "EACCES" || code === "EROFS";
}

async function writePin(path: string, yaml: string): Promise<boolean> {
  try {
    await mkdir(TRAEFIK_DYNAMIC_DIR, { recursive: true });
    await writeFile(`${path}.tmp`, yaml, "utf-8");
    await rename(`${path}.tmp`, path);
    return true;
  } catch (err) {
    if (isMissingVolume(err)) return false;
    throw err;
  }
}

export async function clearCutoverPin(appName: string, envName: string): Promise<void> {
  try {
    await unlink(cutoverPinPath(appName, envName));
  } catch (err) {
    if (!isMissingVolume(err)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Traefik + Docker reads
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` until it returns true or the deadline passes. */
async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL);
  }
}

/** Addresses a compose project's running containers hold. */
async function projectIps(projectName: string): Promise<Set<string>> {
  try {
    const containers = await liveContainers();
    return new Set(
      containers
        .filter((c) => c.labels["com.docker.compose.project"] === projectName)
        .flatMap((c) => c.ips),
    );
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export type CutoverGuard = {
  /** Whether Traefik confirmed the pin. False means the swap runs as it always did. */
  pinned: boolean;
  /** Wait for Traefik to drop the stopped slot, then hand routing back to the labels. */
  release: () => Promise<void>;
};

const NO_PIN: CutoverGuard = { pinned: false, release: async () => {} };

/**
 * Route the app at the new slot only, and confirm Traefik is serving that route
 * before returning. Call immediately before the old slot is stopped, and
 * `release()` immediately after.
 *
 * Every failure path leaves the pin removed and the swap running exactly as it
 * did before, so a Traefik that never picks the file up costs a few seconds and
 * nothing else.
 */
export async function guardCutover(opts: {
  appName: string;
  envName: string;
  compose: ComposeFile;
  slotted: Record<string, ComposeService>;
  newProjectName: string;
  oldProjectName: string;
  log: (line: string) => void;
}): Promise<CutoverGuard> {
  const { appName, envName, log } = opts;
  const path = cutoverPinPath(appName, envName);

  const plan = planCutover(opts.compose, {
    newProjectName: opts.newProjectName,
    slotted: opts.slotted,
  });
  if (!plan) {
    await clearCutoverPin(appName, envName).catch(() => {});
    return NO_PIN;
  }

  const oldIps = await projectIps(opts.oldProjectName);

  let written = false;
  try {
    written = await writePin(path, plan.yaml);
  } catch (err) {
    log(`[deploy] Traefik cutover: could not write pin — ${err instanceof Error ? err.message : err}`);
  }
  if (!written) return NO_PIN;

  const live = await waitUntil(async () => {
    const routers = await fetchTraefikRouters();
    return routers !== null && pinIsLive(routers, plan.routerNames);
  }, PIN_CONFIRM_TIMEOUT);

  if (!live) {
    log(`[deploy] Traefik cutover: pin not picked up in ${PIN_CONFIRM_TIMEOUT / 1000}s — stopping the old slot unpinned`);
    await clearCutoverPin(appName, envName).catch(() => {});
    return NO_PIN;
  }

  log(`[deploy] Traefik cutover: traffic pinned to ${opts.newProjectName} (${plan.routerNames.length} router(s))`);

  return {
    pinned: true,
    release: async () => {
      try {
        if (oldIps.size === 0) {
          log(`[deploy] Traefik cutover: no old-slot addresses to watch — unpinning immediately`);
        } else {
          const dropped = await waitUntil(async () => {
            const services = await fetchTraefikServices();
            if (!services) return false;
            return !collectDockerBackends(services).some((b) => oldIps.has(b.ip));
          }, PIN_RELEASE_TIMEOUT);
          if (!dropped) {
            log(`[deploy] Traefik cutover: old slot still in Traefik after ${PIN_RELEASE_TIMEOUT / 1000}s — unpinning anyway`);
          }
        }
      } finally {
        await clearCutoverPin(appName, envName).catch(() => {});
      }
    },
  };
}
