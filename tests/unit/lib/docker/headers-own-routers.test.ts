import { describe, it, expect } from "vitest";
import { injectHeadersIntoOwnRouters } from "@/lib/docker/compose-inject";
import type { ComposeFile } from "@/lib/docker/compose-types";

const compose = (labels: Record<string, string>): ComposeFile =>
  ({ services: { web: { image: "app", labels } } }) as unknown as ComposeFile;

describe("injectHeadersIntoOwnRouters", () => {
  it("adds the middleware first on HTTPS routers", () => {
    const out = injectHeadersIntoOwnRouters(
      compose({
        "traefik.enable": "true",
        "traefik.http.routers.pouch.rule": "Host(`pouch.email`)",
        "traefik.http.routers.pouch.entrypoints": "websecure",
        "traefik.http.routers.pouch.middlewares": "ratelimit",
        "traefik.http.routers.alt.rule": "Host(`email.example.org`)",
        "traefik.http.routers.alt.tls.certresolver": "le-dns",
      }),
      "pouch",
    ).services.web.labels!;
    expect(out["traefik.http.routers.pouch.middlewares"]).toBe("pouch-vardo-headers,ratelimit");
    expect(out["traefik.http.routers.alt.middlewares"]).toBe("pouch-vardo-headers");
    expect(out["traefik.http.middlewares.pouch-vardo-headers.headers.stsSeconds"]).toBe("31536000");
  });

  it("leaves plain HTTP routers alone", () => {
    const labels = {
      "traefik.http.routers.http.rule": "Host(`pouch.email`)",
      "traefik.http.routers.http.entrypoints": "web",
      "traefik.http.routers.http.middlewares": "to-https",
    };
    expect(injectHeadersIntoOwnRouters(compose(labels), "pouch").services.web.labels).toEqual(labels);
  });
});
