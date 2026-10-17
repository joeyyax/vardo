// GET /v1/self, as forwarded by the metadata proxy.

import { dockerRequest } from "@/lib/docker/client";
import { PEER_HEADER } from "@/lib/security/client-ip";
import {
  PROXY_HEADERS,
  attributeCaller,
  isRefusal,
  peerTrusted,
  proxyAddresses,
  requestRefusal,
  type MetadataCaller,
  type Refusal,
  type RunningContainer,
} from "./caller";
import { assemblePayload, cachedAppFacts, dbSources, resolveSelfApp, type MetadataSources, type SelfMetadata } from "./payload";

const SNAPSHOT_MS = 3_000;
// A container that just started may be missing from the snapshot; a miss refreshes, but no more often than this.
const MISS_REFRESH_MS = 1_000;

let snapshot: { at: number; list: Promise<RunningContainer[]> } = { at: 0, list: Promise.resolve([]) };

/** Running containers with their labels and addresses, shared across requests for SNAPSHOT_MS. */
export function runningContainers(opts: { refresh?: boolean } = {}, now = Date.now()): Promise<RunningContainer[]> {
  const age = now - snapshot.at;
  if (age < SNAPSHOT_MS && !(opts.refresh && age >= MISS_REFRESH_MS)) return snapshot.list;
  const list = dockerRequest<RunningContainer[]>("GET", "/containers/json");
  snapshot = { at: now, list };
  list.catch(() => (snapshot = { at: 0, list: Promise.resolve([]) }));
  return list;
}

const APP_MS = 5_000;
const apps = new Map<string, { at: number; app: ReturnType<typeof resolveSelfApp> }>();

/** resolveSelfApp, cached per container identity for APP_MS. */
function resolvedApp(caller: MetadataCaller, sources: MetadataSources, now = Date.now()): ReturnType<typeof resolveSelfApp> {
  const key = [caller.appId, caller.service, caller.envName, caller.network].join("\n");
  const hit = apps.get(key);
  if (hit && now - hit.at < APP_MS) return hit.app;
  if (apps.size >= 2_000) apps.clear();
  const app = resolveSelfApp(caller, sources);
  apps.set(key, { at: now, app });
  app.catch(() => apps.delete(key));
  return app;
}

export function clearResolvedApps(): void {
  apps.clear();
}

export type HandlerDeps = {
  containers: (opts?: { refresh?: boolean }) => Promise<RunningContainer[]>;
  sources: MetadataSources;
  production: boolean;
};

const defaultDeps = (): HandlerDeps => ({
  containers: runningContainers,
  sources: dbSources,
  production: process.env.NODE_ENV === "production",
});

export type HandlerResult = { status: 200; body: SelfMetadata } | (Refusal & { body?: undefined });

export function isPayload(r: HandlerResult): r is { status: 200; body: SelfMetadata } {
  return r.body !== undefined;
}

/** Checks the request, attributes it to one container and returns that app's payload. */
export async function handleSelf(headers: Headers, deps: HandlerDeps = defaultDeps()): Promise<HandlerResult> {
  const refused = requestRefusal(headers);
  if (refused) return refused;

  let containers = await deps.containers().catch(() => null);
  if (!containers) return { status: 503, error: "Docker is unavailable" };

  const peer = headers.get(PEER_HEADER);
  if (!peerTrusted(peer, proxyAddresses(containers), deps.production)) {
    containers = await deps.containers({ refresh: true }).catch(() => containers!);
    if (!peerTrusted(peer, proxyAddresses(containers), deps.production)) return { status: 403, error: "Only the metadata proxy may call this route" };
  }

  const callerIp = headers.get(PROXY_HEADERS.caller);
  const localIp = headers.get(PROXY_HEADERS.local);
  let caller = attributeCaller(callerIp, localIp, containers);
  if (isRefusal(caller)) {
    containers = await deps.containers({ refresh: true }).catch(() => containers!);
    caller = attributeCaller(callerIp, localIp, containers);
    if (isRefusal(caller)) return caller;
  }

  const app = await resolvedApp(caller, deps.sources);
  if (isRefusal(app)) return app;
  const facts = await cachedAppFacts(app, caller.envName, deps.sources);
  return { status: 200, body: assemblePayload(facts, caller) };
}
