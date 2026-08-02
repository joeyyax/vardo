import { describe, expect, it } from "vitest";
import { composeToYaml, parseCompose } from "@/lib/docker/compose-parse";
import { partitionBySlot } from "@/lib/docker/slot-partition";

const YAML_SOURCE = `services:
  web:
    image: nginx
    depends_on:
      - db
  db:
    image: postgres:17
    x-vardo-shared: true
`;

describe("x-vardo-shared through the compose pipeline", () => {
  it("survives parsing, which is an allowlist", () => {
    const compose = parseCompose(YAML_SOURCE);
    expect(compose.services.db["x-vardo-shared"]).toBe(true);
    expect(compose.services.web["x-vardo-shared"]).toBeUndefined();
  });

  it("survives a YAML round trip, so a redeploy sees the same marker", () => {
    const once = parseCompose(YAML_SOURCE);
    const twice = parseCompose(composeToYaml(once));
    expect(twice.services.db["x-vardo-shared"]).toBe(true);
  });

  it("reaches the partition, which is the only thing that reads it", () => {
    const { shared, slotted } = partitionBySlot(parseCompose(YAML_SOURCE));
    expect(Object.keys(shared)).toEqual(["db"]);
    expect(Object.keys(slotted)).toEqual(["web"]);
  });

  it("ignores a non-boolean value rather than guessing", () => {
    const compose = parseCompose(`services:
  db:
    image: postgres:17
    x-vardo-shared: "yes"
`);
    expect(compose.services.db["x-vardo-shared"]).toBeUndefined();
  });
});

describe("keys the allowlist used to drop", () => {
  const SRC = `services:
  frontend:
    image: app
    group_add:
      - "999"
    container_name: pinned-frontend
  db:
    image: postgres:17
    x-vardo-shared: true
    container_name: vardo-postgres
    group_add:
      - "docker"
`;

  it("keeps group_add, without which a container loses socket access", () => {
    const compose = parseCompose(SRC);
    expect(compose.services.frontend.group_add).toEqual(["999"]);
    expect(compose.services.db.group_add).toEqual(["docker"]);
  });

  it("keeps container_name on a shared service, which is never duplicated", () => {
    expect(parseCompose(SRC).services.db.container_name).toBe("vardo-postgres");
  });

  it("drops container_name on a rotating service, where two slots would collide", () => {
    expect(parseCompose(SRC).services.frontend.container_name).toBeUndefined();
  });

  it("keeps both through a YAML round trip", () => {
    const twice = parseCompose(composeToYaml(parseCompose(SRC)));
    expect(twice.services.db.container_name).toBe("vardo-postgres");
    expect(twice.services.frontend.group_add).toEqual(["999"]);
  });
});
