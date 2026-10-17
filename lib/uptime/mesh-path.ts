// The mesh path's network allowance: checks connect to one peer's tunnel address and nowhere else.
// The address and the ports are fixed here. The check only supplies the Host header, the SNI name and the path.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Readable } from "node:stream";
import { HUB_IP } from "@/lib/mesh/ip-allocator";
import type { HostGuard } from "./core";
import { MESH_PORTS, urlPort } from "./net";

const MAX_REDIRECTS = 5;
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export type TunnelDeps = {
  fetch: typeof fetch;
  guard: HostGuard;
  netConnect: typeof net.connect;
  tlsConnect: typeof tls.connect;
};

const blocked = (message: string) => Object.assign(new Error(message), { name: "BlockedUrlError" });

const MESH_PREFIX = `${HUB_IP.split(".").slice(0, 3).join(".")}.`;

/** The peer's tunnel address when `internalIp` is one host in the mesh subnet, bare or /32, else null. */
export function tunnelAddress(internalIp: string | null | undefined): string | null {
  if (!internalIp) return null;
  const [ip, bits] = internalIp.split("/");
  if (bits !== undefined && bits !== "32") return null;
  if (!net.isIPv4(ip) || !ip.startsWith(MESH_PREFIX)) return null;
  const host = Number(ip.slice(MESH_PREFIX.length));
  return host >= 1 && host <= 254 ? ip : null;
}

function requestOnce(address: string, url: URL, init: RequestInit): Promise<Response> {
  const secure = url.protocol === "https:";
  const transport = secure ? https : http;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        host: address,
        port: urlPort(url),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: { ...headers, host: url.host },
        ...(secure ? { servername: url.hostname } : {}),
        signal: init.signal ?? undefined,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const v of value) responseHeaders.append(name, v);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const stream = NULL_BODY_STATUS.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        if (!stream) res.resume();
        try {
          resolve(new Response(stream, { status, statusText: res.statusMessage, headers: responseHeaders }));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function pinnedUrl(raw: string, ports: readonly number[], address: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw blocked("Unreadable URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw blocked("Not an http URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) !== 0 && host !== address) throw blocked("The mesh path takes host names or the peer's own address");
  if (!ports.includes(urlPort(url))) throw blocked(`Port ${urlPort(url)} isn't reachable over the mesh`);
  return url;
}

/**
 * Fetch, sockets and a host guard that only ever connect to `address:<allowed port>`. Redirects are followed, each hop
 * pinned the same way, so a redirect to another host still lands on the same tunnel address.
 */
export function tunnelDeps(address: string, ports: readonly number[] = MESH_PORTS): TunnelDeps {
  if (!tunnelAddress(address)) throw new Error(`Not a mesh address: ${address}`);

  const fetchPinned = (async (input: string | URL | Request, init: RequestInit = {}) => {
    let url = pinnedUrl(String(input instanceof Request ? input.url : input), ports, address);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await requestOnce(address, url, init);
      const location = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || !location || init.redirect === "manual") return res;
      await res.body?.cancel().catch(() => {});
      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        throw blocked("Redirect to an unreadable location");
      }
      url = pinnedUrl(next, ports, address);
    }
    throw blocked("Too many redirects");
  }) as typeof fetch;

  const refused = () => {
    const socket = new net.Socket();
    queueMicrotask(() => socket.destroy(blocked("Port isn't reachable over the mesh")));
    return socket;
  };

  const netConnect = ((options: net.NetConnectOpts) => {
    const port = (options as net.TcpNetConnectOpts).port;
    return ports.includes(port) ? net.connect({ host: address, port }) : refused();
  }) as unknown as typeof net.connect;

  const tlsConnect = ((options: tls.ConnectionOptions) =>
    options.port && ports.includes(Number(options.port))
      ? tls.connect({ host: address, port: Number(options.port), servername: options.servername })
      : (refused() as unknown as tls.TLSSocket)) as unknown as typeof tls.connect;

  return { fetch: fetchPinned, guard: async () => null, netConnect, tlsConnect };
}
