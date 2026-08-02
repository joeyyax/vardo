import { describe, it, expect } from "vitest";
import { validateCompose, sharedServiceNames } from "@/lib/docker/compose-validate";
import { SHARED_MARKER } from "@/lib/docker/slot-partition";
import type { ComposeFile, ComposeService } from "@/lib/docker/compose-types";

function file(services: Record<string, Partial<ComposeService>>): ComposeFile {
  return {
    services: Object.fromEntries(
      Object.entries(services).map(([name, svc]) => [name, { name, ...svc } as ComposeService]),
    ),
  };
}

describe("validateCompose — x-vardo-shared", () => {
  it("accepts a stack with a shared datastore", () => {
    const { valid, errors } = validateCompose(
      file({ web: { image: "web" }, postgres: { image: "postgres:17", [SHARED_MARKER]: true } }),
    );
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("rejects marking every service", () => {
    const { valid, errors } = validateCompose(
      file({
        web: { image: "web", [SHARED_MARKER]: true },
        postgres: { image: "postgres:17", [SHARED_MARKER]: true },
      }),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("Every service is marked"))).toBe(true);
  });

  it("rejects a shared service depending on a rotating one", () => {
    const { valid, errors } = validateCompose(
      file({
        web: { image: "web" },
        postgres: { image: "postgres:17", [SHARED_MARKER]: true, depends_on: ["web"] },
      }),
    );
    expect(valid).toBe(false);
    expect(
      errors.some((e) => e.includes('"postgres"') && e.includes("depends on web")),
    ).toBe(true);
  });

  it("names the depends_on object form the same way", () => {
    const { errors } = validateCompose(
      file({
        web: { image: "web" },
        postgres: {
          image: "postgres:17",
          [SHARED_MARKER]: true,
          depends_on: { web: { condition: "service_healthy" } },
        },
      }),
    );
    expect(errors.some((e) => e.includes("depends on web"))).toBe(true);
  });

  it("allows a shared service to depend on another shared service", () => {
    const { valid } = validateCompose(
      file({
        web: { image: "web" },
        postgres: { image: "postgres:17", [SHARED_MARKER]: true },
        pgbouncer: { image: "pgbouncer", [SHARED_MARKER]: true, depends_on: ["postgres"] },
      }),
    );
    expect(valid).toBe(true);
  });

  it("rejects marking the labeled Traefik service, and says the deploy ships nothing", () => {
    const { valid, errors } = validateCompose(
      file({
        web: { image: "web", labels: { "traefik.enable": "true" }, [SHARED_MARKER]: true },
        worker: { image: "web" },
      }),
    );
    expect(valid).toBe(false);
    expect(
      errors.some((e) => e.includes("routes traffic to") && e.includes("shipping nothing")),
    ).toBe(true);
  });

  it("rejects marking the service Vardo would route to without labels", () => {
    const { valid, errors } = validateCompose(
      file({ app: { image: "myapp", [SHARED_MARKER]: true }, worker: { image: "myapp" } }),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("routes traffic to"))).toBe(true);
  });

  it("stays quiet when the routed service is a guess between candidates", () => {
    const { valid } = validateCompose(
      file({ proxy: { image: "traefik:v3", [SHARED_MARKER]: true }, api: { image: "myapi" } }),
    );
    expect(valid).toBe(true);
  });

  it("rejects a shared service that builds from source", () => {
    const { valid, errors } = validateCompose(
      file({ web: { image: "web" }, cache: { build: ".", [SHARED_MARKER]: true } }),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('"cache"') && e.includes("--no-recreate"))).toBe(true);
  });

  it("rejects network_mode pointing at a shared service", () => {
    const { valid, errors } = validateCompose(
      file({
        vpn: { image: "vpn", [SHARED_MARKER]: true },
        web: { image: "web", network_mode: "service:vpn" },
      }),
    );
    expect(valid).toBe(false);
    expect(
      errors.some((e) => e.includes('"web"') && e.includes("separate compose projects")),
    ).toBe(true);
  });

  it("leaves network_mode between two rotating services alone", () => {
    const { errors } = validateCompose(
      file({
        vpn: { image: "vpn" },
        web: { image: "web", network_mode: "service:vpn" },
        postgres: { image: "postgres:17", [SHARED_MARKER]: true },
      }),
    );
    expect(errors.some((e) => e.includes("separate compose projects"))).toBe(false);
  });

  it("says nothing about sharing when no service is marked", () => {
    const { valid, errors } = validateCompose(
      file({ web: { image: "web" }, postgres: { image: "postgres:17" } }),
    );
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });
});

describe("sharedServiceNames", () => {
  it("reads the marker off raw YAML", () => {
    expect(
      sharedServiceNames(`
services:
  web:
    image: web
  postgres:
    image: postgres:17
    x-vardo-shared: true
`),
    ).toEqual(["postgres"]);
  });

  it("ignores a non-boolean marker", () => {
    expect(
      sharedServiceNames(`
services:
  postgres:
    image: postgres:17
    x-vardo-shared: "true"
`),
    ).toEqual([]);
  });

  it("returns nothing for unparseable or serviceless YAML", () => {
    expect(sharedServiceNames("::: not yaml :::")).toEqual([]);
    expect(sharedServiceNames("version: '3'")).toEqual([]);
  });
});
