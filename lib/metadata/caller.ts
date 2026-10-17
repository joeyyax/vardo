// Who is asking for /v1/self: request checks, then the source address mapped to one app container.

import { isProjectNetwork } from "@/lib/docker/project-network";

/** Header an app must send, so a crafted URL through an SSRF bug can't read the endpoint. */
export const METADATA_HEADER = "vardo-metadata";
export const METADATA_PROXY_NAME = "vardo-metadata";
/** Network only the proxy and the console join. */
export const METADATA_NETWORK = "vardo-metadata";
/** Name the proxy answers to on every project network. */
export const METADATA_HOST = "vardo.internal";

/** Set by the proxy from the connection, overwriting anything the app sent. */
export const PROXY_HEADERS = {
  caller: "x-vardo-caller",
  local: "x-vardo-local",
  request: "x-vardo-request",
  forwarded: "x-vardo-client-forwarded",
} as const;

export type Refusal = { status: number; error: string };

export type MetadataCaller = {
  containerId: string;
  appId: string;
  envName: string;
  /** Compose service; null when the container has no compose label. */
  service: string | null;
  network: string;
};

type NetworkEntry = { IPAddress?: string; GlobalIPv6Address?: string };

/** The fields of Docker's container list this reads. */
export type RunningContainer = {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string> | null;
  NetworkSettings?: { Networks?: Record<string, NetworkEntry> | null } | null;
};

const ORIGIN_FORM = /^(GET|HEAD) \/\S* HTTP\/\d(?:\.\d)?$/;

function normalize(ip: string | null | undefined): string {
  return (ip ?? "").trim().replace(/^::ffff:/i, "");
}

/** Why the proxy's forwarded request is refused before anyone is looked up, or null. */
export function requestRefusal(headers: Headers): Refusal | null {
  if (headers.get(METADATA_HEADER)?.trim() !== "1") {
    return { status: 400, error: "Send the header Vardo-Metadata: 1" };
  }
  if (headers.get(PROXY_HEADERS.forwarded)) {
    return { status: 400, error: "Requests carrying X-Forwarded-For, Forwarded, X-Real-IP or Via are refused" };
  }
  if (!ORIGIN_FORM.test(headers.get(PROXY_HEADERS.request) ?? "")) {
    return { status: 400, error: "Only a GET for /v1/self in origin form is accepted" };
  }
  return null;
}

function addresses(entry: NetworkEntry | undefined): string[] {
  return [entry?.IPAddress, entry?.GlobalIPv6Address].filter((ip): ip is string => !!ip).map(normalize);
}

function isProxy(c: RunningContainer): boolean {
  return (c.Names ?? []).some((n) => n.replace(/^\//, "") === METADATA_PROXY_NAME);
}

/** The proxy's addresses on the network it shares with the console. */
export function proxyAddresses(containers: RunningContainer[]): Set<string> {
  const proxy = containers.find(isProxy);
  return new Set(addresses(proxy?.NetworkSettings?.Networks?.[METADATA_NETWORK]));
}

/** Whether the TCP peer is the proxy. Without a peer header (dev, no preload) only outside production. */
export function peerTrusted(peer: string | null, proxy: Set<string>, production: boolean): boolean {
  if (!peer) return !production;
  const ip = normalize(peer);
  if (proxy.has(ip)) return true;
  return !production && (ip === "127.0.0.1" || ip === "::1");
}

/**
 * The one Vardo app container on the project network the request arrived on whose address is the caller's.
 * Anything else, including a host-network app, an address two containers claim and a non-project network, is refused.
 */
export function attributeCaller(
  callerIp: string | null,
  localIp: string | null,
  containers: RunningContainer[],
): MetadataCaller | Refusal {
  const caller = normalize(callerIp);
  const local = normalize(localIp);
  if (!caller || !local) return { status: 403, error: "Unknown caller" };

  const proxy = containers.find(isProxy);
  const arrived = Object.entries(proxy?.NetworkSettings?.Networks ?? {}).find(([, entry]) => addresses(entry).includes(local));
  if (!arrived || !isProjectNetwork(arrived[0])) return { status: 403, error: "Unknown caller" };
  const network = arrived[0];

  const matches = containers.filter((c) => !isProxy(c) && addresses(c.NetworkSettings?.Networks?.[network]).includes(caller));
  if (matches.length !== 1) return { status: 403, error: "Unknown caller" };

  const [c] = matches;
  const labels = c.Labels ?? {};
  const appId = labels["vardo.project.id"];
  const envName = labels["vardo.environment"];
  if (labels["vardo.managed"] !== "true" || !appId || !envName) return { status: 403, error: "Unknown caller" };
  return { containerId: c.Id, appId, envName, service: labels["com.docker.compose.service"] || null, network };
}

export function isRefusal<T extends object>(v: T | Refusal): v is Refusal {
  return "error" in v;
}
