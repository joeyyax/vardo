// The proxy that answers http://vardo.internal/v1/self on every project network and forwards only that route to the console.

import { createHash } from "crypto";
import { hostname } from "os";

import { dockerRequest, ensureNetwork } from "@/lib/docker/client";
import { isProjectNetwork } from "@/lib/docker/project-network";
import { inContainer } from "@/lib/infra/monitoring-network";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { METADATA_HOST, METADATA_NETWORK, METADATA_PROXY_NAME, PROXY_HEADERS } from "./caller";

const log = logger.child("metadata");

export const METADATA_PROXY_IMAGE = process.env.VARDO_METADATA_IMAGE || "nginx:1.31.6-alpine";
/** The console's name on the metadata network. */
export const CONSOLE_ALIAS = "vardo-console";
export const METADATA_ROUTE = "/api/internal/metadata/v1/self";
const CONFIG_LABEL = "vardo.metadata.config";
const MEMORY_BYTES = 32 * 1024 * 1024;

/** Where the proxy reaches the console: its alias in a container, the host in dev. */
export function consoleUpstream(): string {
  if (process.env.VARDO_METADATA_UPSTREAM) return process.env.VARDO_METADATA_UPSTREAM;
  const port = process.env.PORT || "3000";
  return inContainer() ? `${CONSOLE_ALIAS}:${port}` : `host.docker.internal:${port}`;
}

/** nginx config: one route, per-caller rate limit, the caller's address in headers the app can't set. */
export function proxyConfig(upstream: string): string {
  if (!/^[a-zA-Z0-9.-]+:\d+$/.test(upstream)) throw new Error(`Invalid metadata upstream: "${upstream}"`);
  return `worker_processes 1;
pid /tmp/nginx.pid;
error_log stderr warn;
events { worker_connections 512; }
http {
  access_log off;
  server_tokens off;
  client_body_temp_path /tmp/body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  client_max_body_size 1k;
  resolver 127.0.0.11 valid=5s ipv6=off;
  limit_req_zone $binary_remote_addr zone=caller:1m rate=5r/s;
  limit_req_status 429;
  server {
    listen 80 default_server;
    location = /v1/self {
      limit_req zone=caller burst=20 nodelay;
      limit_except GET { deny all; }
      set $console http://${upstream};
      proxy_pass $console${METADATA_ROUTE};
      proxy_http_version 1.1;
      proxy_connect_timeout 2s;
      proxy_read_timeout 5s;
      proxy_set_header Host ${METADATA_HOST};
      proxy_set_header Connection "";
      proxy_set_header ${PROXY_HEADERS.caller} $remote_addr;
      proxy_set_header ${PROXY_HEADERS.local} $server_addr;
      proxy_set_header ${PROXY_HEADERS.request} $request;
      proxy_set_header ${PROXY_HEADERS.forwarded} "$http_x_forwarded_for$http_forwarded$http_x_real_ip$http_via";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header Forwarded "";
      proxy_set_header X-Real-IP "";
      proxy_set_header Via "";
      proxy_set_header Cookie "";
      proxy_set_header Authorization "";
    }
    location / { return 404; }
  }
}
`;
}

/** Docker create body for the proxy: unprivileged, read-only, no forwarding between the networks it joins. */
export function proxyCreateBody(config: string, image: string, dev: boolean) {
  const hash = createHash("sha256").update(image).update(config).digest("hex").slice(0, 16);
  return {
    hash,
    body: {
      Image: image,
      User: "101:101",
      Entrypoint: ["sh", "-c", 'printf "%s" "$VARDO_METADATA_CONF" > /tmp/nginx.conf && exec nginx -c /tmp/nginx.conf -g "daemon off;"'],
      Cmd: [],
      Env: [`VARDO_METADATA_CONF=${config}`],
      Labels: { "vardo.role": "metadata-proxy", [CONFIG_LABEL]: hash },
      HostConfig: {
        NetworkMode: METADATA_NETWORK,
        RestartPolicy: { Name: "unless-stopped" },
        Memory: MEMORY_BYTES,
        MemorySwap: MEMORY_BYTES,
        PidsLimit: 64,
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=8m" },
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Sysctls: { "net.ipv4.ip_forward": "0" },
        ...(dev ? { ExtraHosts: ["host.docker.internal:host-gateway"] } : {}),
      },
    },
  };
}

type Inspect = {
  Id: string;
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: { Networks?: Record<string, unknown> };
};

async function inspect(name: string): Promise<Inspect | null> {
  try {
    return await dockerRequest<Inspect>("GET", `/containers/${encodeURIComponent(name)}/json`);
  } catch (err) {
    if (/returned 404/.test(String(err))) return null;
    throw err;
  }
}

async function pull(image: string): Promise<void> {
  const [from, tag] = image.split(/:(?=[^/:]+$)/);
  const query = new URLSearchParams({ fromImage: from, ...(tag ? { tag } : {}) });
  await dockerRequest("POST", `/images/create?${query}`, undefined, { timeoutMs: 120_000 });
}

/** Creates the proxy, or recreates it when its config changed. Returns its container id. */
export async function ensureProxyContainer(): Promise<string> {
  const { hash, body } = proxyCreateBody(proxyConfig(consoleUpstream()), METADATA_PROXY_IMAGE, !inContainer());
  const current = await inspect(METADATA_PROXY_NAME);
  if (current && current.Config?.Labels?.[CONFIG_LABEL] === hash) {
    if (!current.State?.Running) await dockerRequest("POST", `/containers/${current.Id}/start`);
    return current.Id;
  }
  if (current) await dockerRequest("DELETE", `/containers/${current.Id}?force=true`);
  await pull(METADATA_PROXY_IMAGE).catch((err) => log.warn(`Couldn't pull ${METADATA_PROXY_IMAGE}:`, err instanceof Error ? err.message : err));
  const created = await dockerRequest<{ Id: string }>("POST", `/containers/create?name=${METADATA_PROXY_NAME}`, body);
  await dockerRequest("POST", `/containers/${created.Id}/start`);
  log.info(`Started ${METADATA_PROXY_NAME}`);
  return created.Id;
}

/** Puts the proxy on a project network as vardo.internal. Idempotent. */
export async function attachMetadataProxy(network: string, joined?: Set<string>): Promise<boolean> {
  if (!isProjectNetwork(network)) return false;
  if (!joined) {
    const proxy = await inspect(METADATA_PROXY_NAME);
    if (!proxy) return false;
    joined = new Set(Object.keys(proxy.NetworkSettings?.Networks ?? {}));
  }
  if (joined.has(network)) return false;
  try {
    await dockerRequest("POST", `/networks/${encodeURIComponent(network)}/connect`, {
      Container: METADATA_PROXY_NAME,
      EndpointConfig: { Aliases: [METADATA_HOST] },
    });
    return true;
  } catch (err) {
    if (/already exists|is already connected/i.test(String(err))) return false;
    throw err;
  }
}

/** Joins this console to the metadata network under CONSOLE_ALIAS. A no-op outside a container. */
async function joinConsole(): Promise<void> {
  if (!inContainer()) return;
  const self = process.env.CONTAINER_ID || hostname();
  const me = await inspect(self);
  if (!me || METADATA_NETWORK in (me.NetworkSettings?.Networks ?? {})) return;
  await dockerRequest("POST", `/networks/${METADATA_NETWORK}/connect`, {
    Container: me.Id,
    EndpointConfig: { Aliases: [CONSOLE_ALIAS] },
  });
  log.info(`Joined ${METADATA_NETWORK}`);
}

/** Network, proxy, this console and every project network, in that order. Logs, never throws. */
export async function ensureMetadataProxy(): Promise<void> {
  try {
    await ensureNetwork(METADATA_NETWORK, { internal: !!inContainer() });
    await joinConsole();
    await ensureProxyContainer();
    const proxy = await inspect(METADATA_PROXY_NAME);
    const joined = new Set(Object.keys(proxy?.NetworkSettings?.Networks ?? {}));
    const networks = await dockerRequest<{ Name: string }[]>(
      "GET",
      `/networks?filters=${encodeURIComponent(JSON.stringify({ name: ["vardo-p-"] }))}`,
    );
    for (const { Name } of networks) {
      await attachMetadataProxy(Name, joined).catch((err) => log.warn(`Couldn't attach ${METADATA_PROXY_NAME} to ${Name}:`, err instanceof Error ? err.message : err));
    }
  } catch (err) {
    log.warn("Metadata proxy:", err instanceof Error ? err.message : err);
  }
}

/** Keeps the proxy running and on every project network. Per web process, since each console joins the network itself. */
export const metadataProxyLoop = new IntervalLoop({
  name: "metadata-proxy",
  intervalMs: 60_000,
  firstRunMs: 0,
  log,
  run: () => ensureMetadataProxy(),
});
