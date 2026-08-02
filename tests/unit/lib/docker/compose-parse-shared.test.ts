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
