import { describe, it, expect } from "vitest";
import { injectHeadersIntoOwnRouters } from "@/lib/docker/compose-inject";
import type { ComposeFile } from "@/lib/docker/compose-types";
import { RECOMMENDED_HEADERS, headersLabelOptions } from "@/lib/security/response-headers";

const compose = (labels: Record<string, string>): ComposeFile =>
  ({ services: { web: { image: "app", labels } } }) as unknown as ComposeFile;

const FILE = { ref: "vardo-headers-app1@file" };
const LABELS = { options: headersLabelOptions(RECOMMENDED_HEADERS) };

const routers = {
  "traefik.enable": "true",
  "traefik.http.routers.mail.rule": "Host(`mail.example.net`)",
  "traefik.http.routers.mail.entrypoints": "websecure",
  "traefik.http.routers.mail.middlewares": "ratelimit",
  "traefik.http.routers.alt.rule": "Host(`mail.example.org`)",
  "traefik.http.routers.alt.tls.certresolver": "le-dns",
};

describe("injectHeadersIntoOwnRouters", () => {
  it("adds the file middleware first on HTTPS routers", () => {
    const out = injectHeadersIntoOwnRouters(compose(routers), "mail", FILE).services.web.labels!;
    expect(out["traefik.http.routers.mail.middlewares"]).toBe("vardo-headers-app1@file,ratelimit");
    expect(out["traefik.http.routers.alt.middlewares"]).toBe("vardo-headers-app1@file");
    expect(Object.keys(out).filter((k) => k.startsWith("traefik.http.middlewares."))).toEqual([]);
  });

  it("defines label headers when there's no file", () => {
    const out = injectHeadersIntoOwnRouters(compose(routers), "mail", LABELS).services.web.labels!;
    expect(out["traefik.http.routers.mail.middlewares"]).toBe("mail-vardo-headers,ratelimit");
    expect(out["traefik.http.middlewares.mail-vardo-headers.headers.stsSeconds"]).toBe("31536000");
  });

  it("adds nothing without headers", () => {
    for (const headers of [null, { options: {} }]) {
      expect(injectHeadersIntoOwnRouters(compose(routers), "mail", headers).services.web.labels).toEqual(routers);
    }
  });

  it("is idempotent", () => {
    const once = injectHeadersIntoOwnRouters(compose(routers), "mail", FILE);
    const twice = injectHeadersIntoOwnRouters(once, "mail", FILE);
    expect(twice.services.web.labels!["traefik.http.routers.mail.middlewares"]).toBe("vardo-headers-app1@file,ratelimit");
  });

  it("leaves plain HTTP routers alone", () => {
    const labels = {
      "traefik.http.routers.http.rule": "Host(`mail.example.net`)",
      "traefik.http.routers.http.entrypoints": "web",
      "traefik.http.routers.http.middlewares": "to-https",
    };
    expect(injectHeadersIntoOwnRouters(compose(labels), "mail", FILE).services.web.labels).toEqual(labels);
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
      FILE,
    ).services.web.labels!;
    expect(out["traefik.http.routers.mail.middlewares"]).toBe("vardo-headers-app1@file");
  });
});
