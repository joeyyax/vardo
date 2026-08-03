import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { composeToYaml, parseCompose } from "@/lib/docker/compose-parse";
import {
  findMistypedSharedMarkers,
  parseComposeYaml,
  sharedServiceNames,
  validateCompose,
} from "@/lib/docker/compose-validate";
import { partitionBySlot } from "@/lib/docker/slot-partition";
import { SHARED_MARKER } from "@/lib/docker/slot-partition";

const ANCHORED = `x-db: &db
  ${SHARED_MARKER}: true
  volumes:
    - pgdata:/var/lib/postgresql/data
  restart: always
services:
  web:
    image: nginx
  postgres:
    <<: *db
    image: postgres:17
volumes:
  pgdata:
`;

/** Nested sequence merges that expand exponentially once `<<` is resolved. */
const ALIAS_BOMB = (() => {
  let src = "x0: &a0\n  k: v\n";
  for (let i = 1; i <= 8; i++) {
    src += `x${i}: &a${i}\n  <<: [*a${i - 1}, *a${i - 1}, *a${i - 1}]\n  k${i}: v\n`;
  }
  return src + "services:\n  db:\n    <<: *a8\n    image: app\n";
})();

// The yaml package is what decides whether `<<` is a merge key or an ordinary
// one. Pin both behaviors so an upgrade fails the build instead of silently
// changing which services rotate.
describe("yaml package merge-key behavior", () => {
  it("leaves << as a literal key under the default 1.2 schema", () => {
    expect(YAML.parse(ANCHORED).services.postgres).toEqual({
      "<<": { [SHARED_MARKER]: true, volumes: ["pgdata:/var/lib/postgresql/data"], restart: "always" },
      image: "postgres:17",
    });
  });

  it("resolves << when merge is enabled", () => {
    expect(YAML.parse(ANCHORED, { merge: true }).services.postgres).toEqual({
      [SHARED_MARKER]: true,
      volumes: ["pgdata:/var/lib/postgresql/data"],
      restart: "always",
      image: "postgres:17",
    });
  });

  it("gives explicit keys precedence over merged ones", () => {
    const src = `x-db: &db
  image: from-anchor
services:
  postgres:
    <<: *db
    image: postgres:17
`;
    expect(YAML.parse(src, { merge: true }).services.postgres.image).toBe("postgres:17");
  });

  it("gives earlier sequence entries precedence over later ones", () => {
    const src = `x-a: &a
  image: from-a
x-b: &b
  image: from-b
  restart: always
services:
  db:
    <<: [*a, *b]
`;
    expect(YAML.parse(src, { merge: true }).services.db).toEqual({
      image: "from-a",
      restart: "always",
    });
  });

  it("rejects a merge source that is not a map", () => {
    expect(() => YAML.parse("services:\n  db:\n    <<: 5\n", { merge: true })).toThrow();
  });

  it("stops counting aliases once merge resolution is enabled", () => {
    expect(() => YAML.parse(ALIAS_BOMB)).toThrow(/alias/i);
    expect(() => YAML.parse(ALIAS_BOMB, { merge: true })).not.toThrow();
  });
});

describe("alias expansion", () => {
  it("rejects an alias bomb rather than expanding it", () => {
    expect(() => parseComposeYaml(ALIAS_BOMB)).toThrow(/alias/i);
    expect(() => parseCompose(ALIAS_BOMB)).toThrow(/alias/i);
  });

  it("still accepts a compose file that reuses one anchor widely", () => {
    let src = "x-base: &base\n  restart: always\nservices:\n";
    for (let i = 0; i < 40; i++) src += `  svc${i}:\n    <<: *base\n    image: app\n`;
    const compose = parseCompose(src);
    expect(Object.keys(compose.services)).toHaveLength(40);
    expect(compose.services.svc39.restart).toBe("always");
  });
});

describe("parseCompose with merge keys", () => {
  it("honors a marker that arrives through a merge key", () => {
    expect(parseCompose(ANCHORED).services.postgres[SHARED_MARKER]).toBe(true);
  });

  it("keeps the service out of blue/green rotation", () => {
    const { shared, slotted } = partitionBySlot(parseCompose(ANCHORED));
    expect(Object.keys(shared)).toEqual(["postgres"]);
    expect(Object.keys(slotted)).toEqual(["web"]);
  });

  it("carries the rest of the merged service through the allowlist", () => {
    const svc = parseCompose(ANCHORED).services.postgres;
    expect(svc.volumes).toEqual(["pgdata:/var/lib/postgresql/data"]);
    expect(svc.restart).toBe("always");
    expect(svc.image).toBe("postgres:17");
  });

  it("lets an explicit key beat the merged one", () => {
    const src = `x-db: &db
  ${SHARED_MARKER}: true
  restart: always
services:
  web:
    image: nginx
  postgres:
    <<: *db
    ${SHARED_MARKER}: false
    image: postgres:17
`;
    const svc = parseCompose(src).services.postgres;
    expect(svc[SHARED_MARKER]).toBe(false);
    expect(svc.restart).toBe("always");
    expect(Object.keys(partitionBySlot(parseCompose(src)).shared)).toEqual([]);
  });

  it("resolves a sequence merge with earlier entries winning", () => {
    const src = `x-shared: &shared
  ${SHARED_MARKER}: true
x-defaults: &defaults
  ${SHARED_MARKER}: false
  restart: unless-stopped
services:
  web:
    image: nginx
  postgres:
    <<: [*shared, *defaults]
    image: postgres:17
`;
    const svc = parseCompose(src).services.postgres;
    expect(svc[SHARED_MARKER]).toBe(true);
    expect(svc.restart).toBe("unless-stopped");
  });

  it("resolves a merge key nested inside another anchor", () => {
    const src = `x-base: &base
  ${SHARED_MARKER}: true
  restart: always
x-db: &db
  <<: *base
  restart: unless-stopped
services:
  web:
    image: nginx
  postgres:
    <<: *db
    image: postgres:17
`;
    const svc = parseCompose(src).services.postgres;
    expect(svc[SHARED_MARKER]).toBe(true);
    expect(svc.restart).toBe("unless-stopped");
  });

  it("resolves a merge key on the services map itself", () => {
    const src = `x-services: &svcs
  postgres:
    image: postgres:17
    ${SHARED_MARKER}: true
services:
  <<: *svcs
  web:
    image: nginx
`;
    expect(Object.keys(parseCompose(src).services).sort()).toEqual(["postgres", "web"]);
    expect(parseCompose(src).services.postgres[SHARED_MARKER]).toBe(true);
  });

  it("inlines merged keys on the way back out to YAML", () => {
    const twice = parseCompose(composeToYaml(parseCompose(ANCHORED)));
    expect(twice.services.postgres[SHARED_MARKER]).toBe(true);
    expect(twice.services.postgres.volumes).toEqual(["pgdata:/var/lib/postgresql/data"]);
  });

  it("validates the merged service, not the empty one the allowlist used to see", () => {
    const src = `x-db: &db
  image: postgres:17
  ${SHARED_MARKER}: true
services:
  web:
    image: nginx
  postgres:
    <<: *db
`;
    expect(validateCompose(parseCompose(src))).toEqual({ valid: true, errors: [] });
  });
});

describe("raw-YAML validators with merge keys", () => {
  it("reports a merged marker as shared", () => {
    expect(sharedServiceNames(ANCHORED)).toEqual(["postgres"]);
  });

  it("catches a mistyped marker arriving through a merge key", () => {
    const src = `x-db: &db
  ${SHARED_MARKER}: "true"
services:
  postgres:
    <<: *db
    image: postgres:17
`;
    expect(findMistypedSharedMarkers(src)).toEqual([{ service: "postgres", value: "true" }]);
  });
});

describe("Vardo's own compose file", () => {
  const text = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");

  it("parses identically with and without merge resolution", () => {
    expect(parseComposeYaml(text)).toEqual(YAML.parse(text));
  });

  it("still marks its stateful services shared", () => {
    const compose = parseCompose(text);
    const shared = Object.keys(compose.services).filter((n) => compose.services[n][SHARED_MARKER]);
    expect(shared.length).toBeGreaterThan(0);
    expect(Object.keys(partitionBySlot(compose).shared)).toEqual(shared);
  });
});
