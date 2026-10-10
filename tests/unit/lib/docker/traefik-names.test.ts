import { describe, it, expect } from "vitest";

import type { ComposeFile } from "@/lib/docker/compose-types";
import { namespaceTraefikNames } from "@/lib/docker/traefik-names";

const APP = "AbC123";
const P = "abc123";

function compose(labels: Record<string, string>, extra: Record<string, string> = {}): ComposeFile {
  return {
    services: {
      web: { name: "web", labels },
      worker: { name: "worker", labels: extra },
    },
  };
}

const untrusted = { trusted: false };

describe("namespaceTraefikNames", () => {
  it("prefixes routers, services and middlewares with the app id", () => {
    const { compose: out, renamed } = namespaceTraefikNames(
      compose({
        "traefik.http.routers.web.rule": "Host(`app.example.com`)",
        "traefik.http.routers.web.service": "web",
        "traefik.http.routers.web.middlewares": "auth,strip@docker",
        "traefik.http.services.web.loadbalancer.server.port": "3000",
        "traefik.http.middlewares.auth.basicauth.users": "u:h",
        "traefik.http.middlewares.strip.stripprefix.prefixes": "/x",
      }),
      APP,
      untrusted,
    );
    expect(out.services.web.labels).toEqual({
      [`traefik.http.routers.${P}-web.rule`]: "Host(`app.example.com`)",
      [`traefik.http.routers.${P}-web.service`]: `${P}-web`,
      [`traefik.http.routers.${P}-web.middlewares`]: `${P}-auth,${P}-strip@docker`,
      [`traefik.http.services.${P}-web.loadbalancer.server.port`]: "3000",
      [`traefik.http.middlewares.${P}-auth.basicauth.users`]: "u:h",
      [`traefik.http.middlewares.${P}-strip.stripprefix.prefixes`]: "/x",
    });
    expect(renamed.get("web")).toBe(`${P}-web`);
  });

  it("resolves names declared on another service of the same app", () => {
    const { compose: out, foreignRefs } = namespaceTraefikNames(
      compose(
        { "traefik.http.routers.web.middlewares": "shared" },
        { "traefik.http.middlewares.shared.headers.stsSeconds": "1" },
      ),
      APP,
      untrusted,
    );
    expect(foreignRefs).toEqual([]);
    expect(out.services.web.labels?.[`traefik.http.routers.${P}-web.middlewares`]).toBe(`${P}-shared`);
    expect(out.services.worker.labels).toHaveProperty(`traefik.http.middlewares.${P}-shared.headers.stsSeconds`);
  });

  it("keeps names that already carry the prefix", () => {
    const { compose: out, renamed } = namespaceTraefikNames(
      compose({ [`traefik.http.routers.${P}-web.service`]: `${P}-web`, [`traefik.http.services.${P}-web.loadbalancer.server.port`]: "80" }),
      APP,
      untrusted,
    );
    expect(renamed.size).toBe(0);
    expect(out.services.web.labels?.[`traefik.http.routers.${P}-web.service`]).toBe(`${P}-web`);
  });

  it("is idempotent", () => {
    const first = namespaceTraefikNames(compose({ "traefik.tcp.routers.db.service": "db", "traefik.tcp.services.db.loadbalancer.server.port": "5432" }), APP, untrusted);
    const second = namespaceTraefikNames(first.compose, APP, untrusted);
    expect(second.compose).toEqual(first.compose);
  });

  it("flags references to objects the app doesn't define", () => {
    const { foreignRefs } = namespaceTraefikNames(
      compose({
        "traefik.http.routers.web.service": "other-app-svc",
        "traefik.http.routers.web.middlewares": "victim-auth@docker",
        "traefik.http.middlewares.chain.chain.middlewares": "elsewhere",
        "traefik.http.middlewares.err.errors.service": "foreign",
      }),
      APP,
      untrusted,
    );
    expect(foreignRefs.sort()).toEqual(["elsewhere", "foreign", "other-app-svc", "victim-auth@docker"]);
  });

  it("allows Vardo's file middlewares but not other providers' objects for untrusted orgs", () => {
    const labels = {
      "traefik.http.routers.web.middlewares": "cloudflare-only@file,custom@file",
      "traefik.http.routers.web.service": "console@file",
    };
    expect(namespaceTraefikNames(compose(labels), APP, untrusted).foreignRefs.sort()).toEqual(["console@file", "custom@file"]);
    expect(namespaceTraefikNames(compose(labels), APP, { trusted: true }).foreignRefs).toEqual([]);
  });

  it("checks a variable reference as Compose resolves it", () => {
    const ok = namespaceTraefikNames(
      compose({ "traefik.http.routers.web.middlewares": "${MW:-}", "traefik.http.middlewares.auth.basicauth.users": "u:h" }),
      APP,
      untrusted,
    );
    expect(ok.foreignRefs).toEqual([]);

    const own = namespaceTraefikNames(
      compose({ "traefik.http.routers.web.middlewares": "${MW}", "traefik.http.middlewares.auth.basicauth.users": "u:h" }),
      APP,
      { ...untrusted, appEnv: { MW: "auth" } },
    );
    expect(own.compose.services.web.labels?.[`traefik.http.routers.${P}-web.middlewares`]).toBe(`${P}-auth`);

    const foreign = namespaceTraefikNames(compose({ "traefik.http.routers.web.middlewares": "${MW}" }), APP, {
      ...untrusted,
      appEnv: { MW: "victim-auth" },
    });
    expect(foreign.foreignRefs).toEqual(["victim-auth"]);
  });

  it("leaves non-Traefik labels alone", () => {
    const { compose: out } = namespaceTraefikNames(compose({ "traefik.enable": "true", "com.example.x": "y" }), APP, untrusted);
    expect(out.services.web.labels).toEqual({ "traefik.enable": "true", "com.example.x": "y" });
  });
});
