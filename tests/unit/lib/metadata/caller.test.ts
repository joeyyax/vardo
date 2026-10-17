import { describe, expect, it } from "vitest";

import {
  attributeCaller,
  isRefusal,
  peerTrusted,
  proxyAddresses,
  requestRefusal,
  type RunningContainer,
} from "@/lib/metadata/caller";

const NET_A = "vardo-p-proj_a-production";
const NET_B = "vardo-p-proj_b-production";

const proxy: RunningContainer = {
  Id: "proxy",
  Names: ["/vardo-metadata"],
  Labels: { "vardo.role": "metadata-proxy" },
  NetworkSettings: {
    Networks: {
      "vardo-metadata": { IPAddress: "172.30.0.2" },
      [NET_A]: { IPAddress: "10.1.0.2" },
      [NET_B]: { IPAddress: "10.2.0.2" },
      "vardo-network": { IPAddress: "172.18.0.9" },
    },
  },
};

const app = (id: string, appId: string, nets: Record<string, string>, labels: Record<string, string> = {}): RunningContainer => ({
  Id: id,
  Names: [`/${id}`],
  Labels: { "vardo.managed": "true", "vardo.project.id": appId, "vardo.environment": "production", "com.docker.compose.service": "web", ...labels },
  NetworkSettings: { Networks: Object.fromEntries(Object.entries(nets).map(([n, ip]) => [n, { IPAddress: ip }])) },
});

const web = app("c-web", "app-a", { [NET_A]: "10.1.0.5", "vardo-network": "172.18.0.5" });
const other = app("c-other", "app-b", { [NET_B]: "10.2.0.5" });
const containers = [proxy, web, other];

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({ "vardo-metadata": "1", "x-vardo-request": "GET /v1/self HTTP/1.1", ...extra });
}

describe("requestRefusal", () => {
  it("accepts a plain GET with the header", () => {
    expect(requestRefusal(headers())).toBeNull();
  });

  it("refuses a request without Vardo-Metadata: 1", () => {
    const h = headers();
    h.delete("vardo-metadata");
    expect(requestRefusal(h)?.status).toBe(400);
    expect(requestRefusal(headers({ "vardo-metadata": "true" }))?.status).toBe(400);
  });

  it("refuses a request the app sent with forwarding headers", () => {
    expect(requestRefusal(headers({ "x-vardo-client-forwarded": "203.0.113.9" }))?.status).toBe(400);
  });

  it("refuses an absolute-form request line, as a proxy would send", () => {
    expect(requestRefusal(headers({ "x-vardo-request": "GET http://vardo.internal/v1/self HTTP/1.1" }))?.status).toBe(400);
  });

  it("refuses anything but GET or HEAD, and a request the proxy didn't describe", () => {
    expect(requestRefusal(headers({ "x-vardo-request": "POST /v1/self HTTP/1.1" }))?.status).toBe(400);
    const h = headers();
    h.delete("x-vardo-request");
    expect(requestRefusal(h)?.status).toBe(400);
  });
});

describe("attributeCaller", () => {
  it("maps the caller's address on the arriving project network to its container", () => {
    const caller = attributeCaller("10.1.0.5", "10.1.0.2", containers);
    expect(caller).toEqual({ containerId: "c-web", appId: "app-a", envName: "production", service: "web", network: NET_A });
  });

  it("names another app's container as that app, never this one", () => {
    const caller = attributeCaller("10.2.0.5", "10.2.0.2", containers);
    expect(isRefusal(caller)).toBe(false);
    expect(caller).toMatchObject({ appId: "app-b", containerId: "c-other" });
  });

  it("refuses an address no container on that network has", () => {
    expect(attributeCaller("10.1.0.99", "10.1.0.2", containers)).toMatchObject({ status: 403 });
    // Another network's container address, arriving on this network.
    expect(attributeCaller("10.2.0.5", "10.1.0.2", containers)).toMatchObject({ status: 403 });
  });

  it("refuses a request that arrived anywhere but a project network", () => {
    expect(attributeCaller("172.18.0.5", "172.18.0.9", containers)).toMatchObject({ status: 403 });
    expect(attributeCaller("10.1.0.5", "172.30.0.2", containers)).toMatchObject({ status: 403 });
  });

  it("refuses an address two containers claim", () => {
    const twin = app("c-twin", "app-c", { [NET_A]: "10.1.0.5" });
    expect(attributeCaller("10.1.0.5", "10.1.0.2", [...containers, twin])).toMatchObject({ status: 403 });
  });

  it("refuses a container Vardo didn't deploy", () => {
    const stray: RunningContainer = { Id: "stray", Labels: {}, NetworkSettings: { Networks: { [NET_A]: { IPAddress: "10.1.0.7" } } } };
    expect(attributeCaller("10.1.0.7", "10.1.0.2", [...containers, stray])).toMatchObject({ status: 403 });
  });

  it("refuses without the proxy or without addresses", () => {
    expect(attributeCaller("10.1.0.5", "10.1.0.2", [web, other])).toMatchObject({ status: 403 });
    expect(attributeCaller(null, "10.1.0.2", containers)).toMatchObject({ status: 403 });
    expect(attributeCaller("10.1.0.5", null, containers)).toMatchObject({ status: 403 });
  });

  it("matches IPv4-mapped addresses", () => {
    expect(attributeCaller("::ffff:10.1.0.5", "::ffff:10.1.0.2", containers)).toMatchObject({ appId: "app-a" });
  });
});

describe("peerTrusted", () => {
  const ips = proxyAddresses(containers);

  it("trusts only the proxy's address on the metadata network in production", () => {
    expect(ips).toEqual(new Set(["172.30.0.2"]));
    expect(peerTrusted("172.30.0.2", ips, true)).toBe(true);
    expect(peerTrusted("10.1.0.2", ips, true)).toBe(false);
    expect(peerTrusted("172.18.0.3", ips, true)).toBe(false);
    expect(peerTrusted("127.0.0.1", ips, true)).toBe(false);
    expect(peerTrusted(null, ips, true)).toBe(false);
  });

  it("lets dev through without the preload or from loopback", () => {
    expect(peerTrusted(null, ips, false)).toBe(true);
    expect(peerTrusted("::1", ips, false)).toBe(true);
    expect(peerTrusted("10.9.9.9", ips, false)).toBe(false);
  });
});
