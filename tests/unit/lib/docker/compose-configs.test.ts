import { describe, expect, it } from "vitest";
import { composeToYaml, parseCompose } from "@/lib/docker/compose-parse";
import { stripVardoInjections } from "@/lib/docker/compose-inject";
import { droppedKeyWarnings, parseComposeYaml } from "@/lib/docker/compose-validate";
import { partitionBySlot } from "@/lib/docker/slot-partition";

/** Promtail's shape: a scrape config delivered entirely through `configs:`. */
const PROMTAIL_SOURCE = `services:
  promtail:
    image: grafana/promtail:3.4
    command:
      - -config.file=/etc/promtail/config.yml
    configs:
      - source: promtail-config
        target: /etc/promtail/config.yml
    networks:
      - vardo-network

networks:
  vardo-network:
    external: true

configs:
  promtail-config:
    content: |
      clients:
        - url: http://loki:3100/loki/api/v1/push
`;

describe("configs and secrets through the compose pipeline", () => {
  it("survives parsing, which is an allowlist", () => {
    const compose = parseCompose(PROMTAIL_SOURCE);
    expect(compose.configs).toEqual({
      "promtail-config": {
        content: "clients:\n  - url: http://loki:3100/loki/api/v1/push\n",
      },
    });
    expect(compose.services.promtail.configs).toEqual([
      { source: "promtail-config", target: "/etc/promtail/config.yml" },
    ]);
  });

  it("survives a YAML round trip, so the config still reaches the container", () => {
    const once = parseCompose(PROMTAIL_SOURCE);
    const twice = parseCompose(composeToYaml(once));
    expect(twice.configs).toEqual(once.configs);
    expect(twice.services.promtail.configs).toEqual(once.services.promtail.configs);
  });

  it("survives the deploy transform that strips Vardo's own network", () => {
    const stripped = stripVardoInjections(parseCompose(PROMTAIL_SOURCE), "vardo-network");
    expect(stripped.configs).toBeDefined();
    expect(stripped.services.promtail.configs).toHaveLength(1);
  });

  it("survives slot partitioning", () => {
    const { slotted } = partitionBySlot(parseCompose(PROMTAIL_SOURCE));
    expect(slotted.promtail.configs).toHaveLength(1);
  });

  it("accepts the short form and normalizes secrets the same way", () => {
    const compose = parseCompose(`services:
  api:
    image: nginx
    configs:
      - api-config
    secrets:
      - source: db-password
        target: /run/secrets/db
        mode: 292

configs:
  api-config:
    file: ./api.yml

secrets:
  db-password:
    file: ./db.txt
`);
    expect(compose.services.api.configs).toEqual(["api-config"]);
    expect(compose.services.api.secrets).toEqual([
      { source: "db-password", target: "/run/secrets/db", mode: 292 },
    ]);
    expect(compose.secrets).toEqual({ "db-password": { file: "./db.txt" } });
  });

  it("no longer warns about configs, now that they are applied", () => {
    expect(droppedKeyWarnings(parseComposeYaml(PROMTAIL_SOURCE))).toEqual([]);
  });

  it("warns about a key Docker honors and Vardo drops", () => {
    const warnings = droppedKeyWarnings(
      parseComposeYaml(`services:
  promtail:
    image: grafana/promtail:3.4
    mem_limit: 128m
    read_only: true
  api:
    image: nginx
`),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"mem_limit"');
    expect(warnings[0]).toContain('"read_only"');
    expect(warnings[0]).toContain('Service "promtail"');
  });

  it("drops a reference with no source rather than emitting a broken mount", () => {
    const compose = parseCompose(`services:
  api:
    image: nginx
    configs:
      - target: /etc/only-a-target.yml
`);
    expect(compose.services.api.configs).toBeUndefined();
  });
});
