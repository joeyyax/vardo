import { describe, it, expect } from "vitest";
import {
  validateCompose,
  sharedServiceNames,
  findMistypedSharedMarkers,
  sharedMarkerTypeErrors,
} from "@/lib/docker/compose-validate";
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

describe("findMistypedSharedMarkers", () => {
  const withMarker = (value: string) => `
services:
  web:
    image: web
  postgres:
    image: postgres:17
    ${SHARED_MARKER}: ${value}
`;

  it("catches the quoted marker the parser drops", () => {
    expect(findMistypedSharedMarkers(withMarker('"true"'))).toEqual([
      { service: "postgres", value: "true" },
    ]);
    expect(findMistypedSharedMarkers(withMarker("'true'"))).toEqual([
      { service: "postgres", value: "true" },
    ]);
  });

  // The yaml package resolves the YAML 1.2 core schema: only true/false and
  // their capitalizations are booleans. The 1.1 spellings are plain strings.
  it.each(["yes", "Yes", "YES", "on", "On", "ON", "y", "Y"])(
    "catches the YAML 1.1 truthy spelling %s",
    (value) => {
      expect(findMistypedSharedMarkers(withMarker(value))).toEqual([
        { service: "postgres", value },
      ]);
    },
  );

  it.each(["no", "No", "off", "Off", "n", "N", '"false"'])(
    "catches the falsy near-miss %s",
    (value) => {
      expect(findMistypedSharedMarkers(withMarker(value))).toHaveLength(1);
    },
  );

  it("catches numeric, null and structured values", () => {
    expect(findMistypedSharedMarkers(withMarker("1"))).toEqual([
      { service: "postgres", value: 1 },
    ]);
    expect(findMistypedSharedMarkers(withMarker("0"))).toEqual([
      { service: "postgres", value: 0 },
    ]);
    expect(findMistypedSharedMarkers(withMarker("null"))).toEqual([
      { service: "postgres", value: null },
    ]);
    expect(findMistypedSharedMarkers(withMarker("[]"))).toHaveLength(1);
  });

  it("catches a typo in the casing the parser would not read", () => {
    expect(findMistypedSharedMarkers(withMarker("tRue"))).toEqual([
      { service: "postgres", value: "tRue" },
    ]);
  });

  it.each(["true", "True", "TRUE", "false", "False", "FALSE"])(
    "accepts the boolean %s",
    (value) => {
      expect(findMistypedSharedMarkers(withMarker(value))).toEqual([]);
    },
  );

  it("accepts a compose file with no marker at all", () => {
    expect(
      findMistypedSharedMarkers(`
services:
  web:
    image: web
`),
    ).toEqual([]);
  });

  it("reports every offending service", () => {
    const found = findMistypedSharedMarkers(`
services:
  postgres:
    image: postgres:17
    ${SHARED_MARKER}: "true"
  redis:
    image: redis
    ${SHARED_MARKER}: yes
`);
    expect(found.map((f) => f.service)).toEqual(["postgres", "redis"]);
  });

  it("returns nothing for unparseable or serviceless YAML", () => {
    expect(findMistypedSharedMarkers("::: not yaml :::")).toEqual([]);
    expect(findMistypedSharedMarkers("")).toEqual([]);
    expect(findMistypedSharedMarkers("version: '3'")).toEqual([]);
  });
});

describe("sharedMarkerTypeErrors", () => {
  it("names the service, the value and the fix", () => {
    const [error] = sharedMarkerTypeErrors(`
services:
  postgres:
    image: postgres:17
    ${SHARED_MARKER}: "true"
`);
    expect(error).toContain('"postgres"');
    expect(error).toContain('the string "true"');
    expect(error).toContain(`${SHARED_MARKER}: true`);
  });

  it("is empty for a correctly marked file", () => {
    expect(
      sharedMarkerTypeErrors(`
services:
  web:
    image: web
  postgres:
    image: postgres:17
    ${SHARED_MARKER}: true
`),
    ).toEqual([]);
  });
});
