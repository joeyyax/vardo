// ---------------------------------------------------------------------------
// The cutover pin mirrors the app's Docker routers as a file-provider config
// aimed at the new slot, so the old slot carries no traffic before it stops.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import YAML from "yaml";

import { planCutover, pinIsLive } from "@/lib/docker/traefik-cutover";
import type { ComposeFile, ComposeService } from "@/lib/docker/compose-types";

const RULE = "Host(`app.example.com`)";

function routedLabels(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "traefik.enable": "true",
    "traefik.http.routers.app-1a2b3c4d.rule": RULE,
    "traefik.http.routers.app-1a2b3c4d.service": "app",
    "traefik.http.routers.app-1a2b3c4d.entrypoints": "websecure",
    "traefik.http.routers.app-1a2b3c4d.tls": "true",
    "traefik.http.routers.app-1a2b3c4d.tls.certresolver": "le-dns",
    "traefik.http.services.app.loadbalancer.server.port": "3000",
    ...overrides,
  };
}

function svc(name: string, fields: Partial<ComposeService> = {}): ComposeService {
  return { name, ...fields };
}

function plan(
  services: Record<string, ComposeService>,
  slotted?: Record<string, ComposeService>,
) {
  return planCutover({ services } as ComposeFile, {
    newProjectName: "app-production-green",
    slotted: slotted ?? services,
  });
}

function parse(yaml: string) {
  return YAML.parse(yaml) as {
    http: {
      routers: Record<string, Record<string, unknown>>;
      services: Record<string, { loadBalancer: { servers: { url: string }[]; serversTransport?: string } }>;
      serversTransports?: Record<string, { insecureSkipVerify: boolean }>;
    };
  };
}

describe("planCutover", () => {
  it("points the pinned service at the new slot's container by name", () => {
    const result = plan({ web: svc("web", { labels: routedLabels() }) });
    const config = parse(result!.yaml);

    expect(config.http.services["app-cutover"].loadBalancer.servers).toEqual([
      { url: "http://app-production-green-web-1:3000" },
    ]);
  });

  it("names the pinned routers so the caller can confirm them in Traefik", () => {
    const result = plan({ web: svc("web", { labels: routedLabels() }) });
    expect(result!.routerNames).toEqual(["app-1a2b3c4d-cutover"]);
  });

  it("outranks the Docker twin by exactly one", () => {
    const result = plan({ web: svc("web", { labels: routedLabels() }) });
    const router = parse(result!.yaml).http.routers["app-1a2b3c4d-cutover"];
    // Traefik defaults a router's priority to its rule length.
    expect(router.priority).toBe(RULE.length + 1);
  });

  it("keeps an explicit priority's ordering, one above the twin", () => {
    const result = plan({
      web: svc("web", { labels: routedLabels({ "traefik.http.routers.app-1a2b3c4d.priority": "5" }) }),
    });
    const router = parse(result!.yaml).http.routers["app-1a2b3c4d-cutover"];
    expect(router.priority).toBe(6);
  });

  it("carries the entrypoints and TLS resolver across", () => {
    const result = plan({ web: svc("web", { labels: routedLabels() }) });
    const router = parse(result!.yaml).http.routers["app-1a2b3c4d-cutover"];
    expect(router.entryPoints).toEqual(["websecure"]);
    expect(router.tls).toEqual({ certResolver: "le-dns" });
  });

  it("declares TLS with no resolver for a local domain", () => {
    const labels = routedLabels();
    delete labels["traefik.http.routers.app-1a2b3c4d.tls.certresolver"];
    const router = parse(plan({ web: svc("web", { labels }) })!.yaml).http.routers["app-1a2b3c4d-cutover"];
    expect(router.tls).toEqual({});
  });

  it("qualifies label middlewares to the Docker provider", () => {
    const result = plan({
      web: svc("web", {
        labels: routedLabels({
          "traefik.http.routers.app-1a2b3c4d.middlewares": "app-1a2b3c4d-https-redirect",
        }),
      }),
    });
    const router = parse(result!.yaml).http.routers["app-1a2b3c4d-cutover"];
    expect(router.middlewares).toEqual(["app-1a2b3c4d-https-redirect@docker"]);
  });

  it("leaves an already-qualified middleware alone", () => {
    const result = plan({
      web: svc("web", {
        labels: routedLabels({
          "traefik.http.routers.app-1a2b3c4d.middlewares": "compress@file",
        }),
      }),
    });
    const router = parse(result!.yaml).http.routers["app-1a2b3c4d-cutover"];
    expect(router.middlewares).toEqual(["compress@file"]);
  });

  it("gives an https backend its own insecure transport", () => {
    const result = plan({
      web: svc("web", {
        labels: routedLabels({
          "traefik.http.services.app.loadbalancer.server.scheme": "https",
        }),
      }),
    });
    const config = parse(result!.yaml);
    expect(config.http.services["app-cutover"].loadBalancer.servers[0].url).toBe(
      "https://app-production-green-web-1:3000",
    );
    expect(config.http.services["app-cutover"].loadBalancer.serversTransport).toBe(
      "app-cutover-insecure",
    );
    expect(config.http.serversTransports!["app-cutover-insecure"]).toEqual({
      insecureSkipVerify: true,
    });
  });

  it("resolves a router against a service another slotted container declares", () => {
    const result = plan({
      web: svc("web", {
        labels: {
          "traefik.enable": "true",
          "traefik.http.routers.app-1a2b3c4d.rule": RULE,
          "traefik.http.routers.app-1a2b3c4d.service": "app",
          "traefik.http.routers.app-1a2b3c4d.entrypoints": "web",
        },
      }),
      api: svc("api", {
        labels: {
          "traefik.enable": "true",
          "traefik.http.services.app.loadbalancer.server.port": "8080",
        },
      }),
    });
    expect(parse(result!.yaml).http.services["app-cutover"].loadBalancer.servers).toEqual([
      { url: "http://app-production-green-api-1:8080" },
    ]);
  });

  it("never pins a shared service — it is not replaced by the swap", () => {
    const services = {
      web: svc("web", { labels: routedLabels() }),
      traefik: svc("traefik", { labels: routedLabels() }),
    };
    const result = plan(services, { web: services.web });
    const config = parse(result!.yaml);
    expect(config.http.services["app-cutover"].loadBalancer.servers).toEqual([
      { url: "http://app-production-green-web-1:3000" },
    ]);
  });

  it("returns null when no shared service is left to route", () => {
    const services = { traefik: svc("traefik", { labels: routedLabels() }) };
    expect(plan(services, {})).toBeNull();
  });

  it("skips a service that opted out of Traefik", () => {
    expect(plan({ web: svc("web", { labels: { "traefik.enable": "false" } }) })).toBeNull();
  });

  it("returns null for an app with no Traefik labels", () => {
    expect(plan({ web: svc("web", { image: "nginx" }) })).toBeNull();
  });

  it("leaves a router whose service nothing declares on the Docker provider", () => {
    const labels = routedLabels();
    delete labels["traefik.http.services.app.loadbalancer.server.port"];
    expect(plan({ web: svc("web", { labels }) })).toBeNull();
  });

  it("mirrors every router the app declares, including the http redirect", () => {
    const result = plan({
      web: svc("web", {
        labels: routedLabels({
          "traefik.http.routers.app-1a2b3c4d-http.rule": RULE,
          "traefik.http.routers.app-1a2b3c4d-http.service": "app",
          "traefik.http.routers.app-1a2b3c4d-http.entrypoints": "web",
        }),
      }),
    });
    expect(result!.routerNames.sort()).toEqual([
      "app-1a2b3c4d-cutover",
      "app-1a2b3c4d-http-cutover",
    ]);
  });
});

describe("pinIsLive", () => {
  const names = ["app-1a2b3c4d-cutover"];

  it("is live once Traefik reports the router enabled", () => {
    expect(pinIsLive([{ name: "app-1a2b3c4d-cutover@file", status: "enabled" }], names)).toBe(true);
  });

  it("is not live while the router is still warming up", () => {
    expect(pinIsLive([{ name: "app-1a2b3c4d-cutover@file", status: "warning" }], names)).toBe(false);
  });

  it("is not live when Traefik has not seen the file at all", () => {
    expect(pinIsLive([{ name: "other@docker", status: "enabled" }], names)).toBe(false);
  });

  it("needs every pinned router, not just one", () => {
    const routers = [{ name: "a-cutover@file", status: "enabled" }];
    expect(pinIsLive(routers, ["a-cutover", "b-cutover"])).toBe(false);
  });
});
