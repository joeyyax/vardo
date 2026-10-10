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
        "traefik.http.routers.mail.rule": "Host(`mail.example.net`)",
        "traefik.http.routers.mail.entrypoints": "websecure",
        "traefik.http.routers.mail.middlewares": "ratelimit",
        "traefik.http.routers.alt.rule": "Host(`mail.example.org`)",
        "traefik.http.routers.alt.tls.certresolver": "le-dns",
      }),
      "mail",
    ).services.web.labels!;
    expect(out["traefik.http.routers.mail.middlewares"]).toBe("mail-vardo-headers,ratelimit");
    expect(out["traefik.http.routers.alt.middlewares"]).toBe("mail-vardo-headers");
    expect(out["traefik.http.middlewares.mail-vardo-headers.headers.stsSeconds"]).toBe("31536000");
  });

  it("leaves plain HTTP routers alone", () => {
    const labels = {
      "traefik.http.routers.http.rule": "Host(`mail.example.net`)",
      "traefik.http.routers.http.entrypoints": "web",
      "traefik.http.routers.http.middlewares": "to-https",
    };
    expect(injectHeadersIntoOwnRouters(compose(labels), "mail").services.web.labels).toEqual(labels);
  });
});

describe("self-routed services", () => {
  it("get the middleware too", () => {
    const out = injectHeadersIntoOwnRouters(
      compose({
        "vardo.traefik": "manual",
        "traefik.http.routers.mail.rule": "Host(`mail.example.net`)",
        "traefik.http.routers.mail.tls.certresolver": "le-dns",
      }),
      "mail",
    ).services.web.labels!;
    expect(out["traefik.http.routers.mail.middlewares"]).toBe("mail-vardo-headers");
  });
});
