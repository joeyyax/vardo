import { describe, it, expect } from "vitest";

import { slotTraefikNames } from "@/lib/docker/traefik-slot-names";
import { planCutover, pinIsLive } from "@/lib/docker/traefik-cutover";
import type { ComposeFile } from "@/lib/docker/compose-types";

function compose(services: Record<string, Record<string, string>>): ComposeFile {
  return {
    services: Object.fromEntries(
      Object.entries(services).map(([name, labels]) => [name, { name, image: `${name}:latest`, labels }]),
    ),
  };
}

function labelsOf(file: ComposeFile, service: string): Record<string, string> {
  return file.services[service].labels ?? {};
}

function routerNames(labels: Record<string, string>): Set<string> {
  return new Set(
    Object.keys(labels)
      .map((k) => /^traefik\.http\.routers\.([^.]+)\./.exec(k)?.[1])
      .filter((n): n is string => !!n),
  );
}

/** The shape of #904: notes-api's own router, before and after a cert resolver change. */
function notes(certResolver: string): ComposeFile {
  return compose({
    notes: {
      "traefik.enable": "true",
      "traefik.http.routers.notes.rule": "Host(`notes.example.com`)",
      "traefik.http.routers.notes.entrypoints": "websecure",
      "traefik.http.routers.notes.tls.certresolver": certResolver,
      "traefik.http.services.notes.loadbalancer.server.port": "8000",
    },
  });
}

describe("slotTraefikNames", () => {
  it("gives each slot its own router when a label changed between deploys (#904)", () => {
    const blue = labelsOf(slotTraefikNames(notes("cloudflare"), "blue"), "notes");
    const green = labelsOf(slotTraefikNames(notes("le-dns"), "green"), "notes");

    expect(blue["traefik.http.routers.notes-blue.tls.certresolver"]).toBe("cloudflare");
    expect(green["traefik.http.routers.notes-green.tls.certresolver"]).toBe("le-dns");
    const shared = [...routerNames(blue)].filter((n) => routerNames(green).has(n));
    expect(shared).toEqual([]);
  });

  it("drops the original router name", () => {
    const labels = labelsOf(slotTraefikNames(notes("le-dns"), "green"), "notes");
    expect(Object.keys(labels).some((k) => k.startsWith("traefik.http.routers.notes."))).toBe(false);
  });

  it("points a router that named no service at the container's slot service", () => {
    const labels = labelsOf(slotTraefikNames(notes("le-dns"), "green"), "notes");
    expect(labels["traefik.http.routers.notes-green.service"]).toBe("notes-green");
  });

  it("keeps the original service beside the slot copy", () => {
    const labels = labelsOf(slotTraefikNames(notes("le-dns"), "green"), "notes");
    expect(labels["traefik.http.services.notes.loadbalancer.server.port"]).toBe("8000");
    expect(labels["traefik.http.services.notes-green.loadbalancer.server.port"]).toBe("8000");
  });

  it("rewrites service and middleware references the app declares", () => {
    const file = compose({
      web: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`app.test`)",
        "traefik.http.routers.web.service": "web",
        "traefik.http.routers.web.middlewares": "auth, compress@docker,sso@file,other-app-mw",
        "traefik.http.middlewares.auth.basicauth.users": "u:p",
        "traefik.http.middlewares.compress.compress": "true",
        "traefik.http.middlewares.stack.chain.middlewares": "auth,sso@file",
        "traefik.http.services.web.loadbalancer.server.port": "3000",
      },
    });
    const labels = labelsOf(slotTraefikNames(file, "blue"), "web");

    expect(labels["traefik.http.routers.web-blue.service"]).toBe("web-blue");
    expect(labels["traefik.http.routers.web-blue.middlewares"]).toBe(
      "auth-blue,compress-blue@docker,sso@file,other-app-mw",
    );
    expect(labels["traefik.http.middlewares.auth.basicauth.users"]).toBe("u:p");
    expect(labels["traefik.http.middlewares.auth-blue.basicauth.users"]).toBe("u:p");
    expect(labels["traefik.http.middlewares.stack.chain.middlewares"]).toBe("auth,sso@file");
    expect(labels["traefik.http.middlewares.stack-blue.chain.middlewares"]).toBe("auth-blue,sso@file");
  });

  it("leaves references to other providers and undeclared names alone", () => {
    const file = compose({
      web: {
        "traefik.enable": "true",
        "traefik.http.routers.dash.rule": "Host(`dash.test`)",
        "traefik.http.routers.dash.service": "api@internal",
        "traefik.http.routers.web.rule": "Host(`app.test`)",
        "traefik.http.routers.web.service": "someone-else",
        "traefik.http.routers.web.middlewares": "${LOCK_MIDDLEWARES:-}",
      },
    });
    const labels = labelsOf(slotTraefikNames(file, "green"), "web");

    expect(labels["traefik.http.routers.dash-green.service"]).toBe("api@internal");
    expect(labels["traefik.http.routers.web-green.service"]).toBe("someone-else");
    expect(labels["traefik.http.routers.web-green.middlewares"]).toBe("${LOCK_MIDDLEWARES:-}");
  });

  it("resolves references across the app's services", () => {
    const file = compose({
      web: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`app.test`)",
        "traefik.http.routers.web.service": "api",
      },
      api: {
        "traefik.enable": "true",
        "traefik.http.services.api.loadbalancer.server.port": "8080",
      },
    });
    const labels = labelsOf(slotTraefikNames(file, "blue"), "web");
    expect(labels["traefik.http.routers.web-blue.service"]).toBe("api-blue");
  });

  it("resolves against another compose when given one", () => {
    const bare = compose({
      web: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`app.test`)",
        "traefik.http.routers.web.middlewares": "auth",
      },
    });
    const full = compose({
      ...Object.fromEntries(Object.entries(bare.services).map(([n, s]) => [n, s.labels!])),
      proxy: { "traefik.http.middlewares.auth.basicauth.users": "u:p" },
    });
    const labels = labelsOf(slotTraefikNames(bare, "blue", { declaredIn: full }), "web");
    expect(labels["traefik.http.routers.web-blue.middlewares"]).toBe("auth-blue");
  });

  it("leaves shared services and references to them untouched", () => {
    const file = compose({
      web: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`app.test`)",
        "traefik.http.routers.web.service": "db-admin",
      },
      admin: {
        "traefik.enable": "true",
        "traefik.http.routers.admin.rule": "Host(`admin.test`)",
        "traefik.http.services.db-admin.loadbalancer.server.port": "8080",
      },
    });
    const result = slotTraefikNames(file, "green", { shared: new Set(["admin"]) });

    expect(result.services.admin).toBe(file.services.admin);
    expect(labelsOf(result, "web")["traefik.http.routers.web-green.service"]).toBe("db-admin");
  });

  it("renames TCP routers and services", () => {
    const file = compose({
      db: {
        "traefik.enable": "true",
        "traefik.tcp.routers.pg.rule": "HostSNI(`db.test`)",
        "traefik.tcp.routers.pg.tls": "true",
        "traefik.tcp.services.pg.loadbalancer.server.port": "5432",
      },
    });
    const labels = labelsOf(slotTraefikNames(file, "blue"), "db");

    expect(labels["traefik.tcp.routers.pg-blue.rule"]).toBe("HostSNI(`db.test`)");
    expect(labels["traefik.tcp.routers.pg-blue.service"]).toBe("pg-blue");
    expect(labels["traefik.tcp.services.pg-blue.loadbalancer.server.port"]).toBe("5432");
    expect(labels["traefik.tcp.routers.pg.rule"]).toBeUndefined();
  });

  it("leaves UDP labels alone", () => {
    const file = compose({
      dns: {
        "traefik.enable": "true",
        "traefik.udp.routers.dns.entrypoints": "dns",
        "traefik.udp.services.dns.loadbalancer.server.port": "53",
      },
    });
    expect(labelsOf(slotTraefikNames(file, "blue"), "dns")).toEqual(labelsOf(file, "dns"));
  });

  it("keeps explicit priorities and other labels", () => {
    const file = compose({
      web: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "PathPrefix(`/`)",
        "traefik.http.routers.web.priority": "1",
        "com.example.owner": "ops",
      },
    });
    const labels = labelsOf(slotTraefikNames(file, "blue"), "web");

    expect(labels["traefik.http.routers.web-blue.priority"]).toBe("1");
    expect(labels["com.example.owner"]).toBe("ops");
    expect(labels["traefik.enable"]).toBe("true");
  });

  it("returns a compose without Traefik objects unchanged", () => {
    const file = compose({ worker: { "com.example.owner": "ops" } });
    expect(slotTraefikNames(file, "blue")).toBe(file);
  });
});

describe("cutover pin with slot names", () => {
  it("pins the new slot's routers and confirms them by their pin names", () => {
    const file = notes("le-dns");
    const live = slotTraefikNames(file, "green");
    const plan = planCutover(file, {
      newProjectName: "notes-production-green",
      slotted: file.services,
      liveLabels: { notes: labelsOf(live, "notes") },
    });

    expect(plan!.routerNames).toEqual(["notes-green-cutover"]);
    expect(plan!.yaml).toContain("http://notes-production-green-notes-1:8000");
    expect(
      pinIsLive([{ name: "notes-green-cutover@file", status: "enabled" }], plan!.routerNames),
    ).toBe(true);
    expect(pinIsLive([{ name: "notes-cutover@file", status: "enabled" }], plan!.routerNames)).toBe(false);
  });

  it("carries the slot's middleware names into the pin", () => {
    const file = compose({
      web: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`app.test`)",
        "traefik.http.routers.web.middlewares": "auth",
        "traefik.http.middlewares.auth.basicauth.users": "u:p",
        "traefik.http.services.web.loadbalancer.server.port": "3000",
      },
    });
    const live = slotTraefikNames(file, "blue");
    const plan = planCutover(file, {
      newProjectName: "app-production-blue",
      slotted: file.services,
      liveLabels: { web: labelsOf(live, "web") },
    });

    expect(plan!.yaml).toContain("auth-blue@docker");
  });
});
