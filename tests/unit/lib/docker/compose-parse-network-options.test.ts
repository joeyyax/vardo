import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { composeToYaml, parseCompose } from "@/lib/docker/compose-parse";
import { stripVardoInjections } from "@/lib/docker/compose-inject";

const SRC = `services:
  wireguard:
    image: linuxserver/wireguard
    networks:
      internal:
      mesh:
        ipv4_address: 10.88.0.2
      vardo-network:
        gw_priority: 100
  worker:
    image: app
    networks:
      - internal
networks:
  internal:
  mesh:
    ipam:
      config:
        - subnet: 10.88.0.0/24
  vardo-network:
    external: true
`;

type Doc = { services: Record<string, { networks?: unknown }> };
const services = (yaml: string) => (YAML.parse(yaml) as Doc).services;

describe("per-network service settings", () => {
  it("keeps network names in order", () => {
    expect(parseCompose(SRC).services.wireguard.networks).toEqual(["internal", "mesh", "vardo-network"]);
  });

  it("keeps ipv4_address and gw_priority", () => {
    expect(parseCompose(SRC).services.wireguard.network_options).toEqual({
      mesh: { ipv4_address: "10.88.0.2" },
      "vardo-network": { gw_priority: 100 },
    });
  });

  it("writes them back in the map form", () => {
    expect(services(composeToYaml(parseCompose(SRC))).wireguard.networks).toEqual({
      internal: null,
      mesh: { ipv4_address: "10.88.0.2" },
      "vardo-network": { gw_priority: 100 },
    });
  });

  it("survives a second round trip", () => {
    const once = composeToYaml(parseCompose(SRC));
    expect(composeToYaml(parseCompose(once))).toBe(once);
  });

  it("leaves the list form alone", () => {
    const worker = parseCompose(SRC).services.worker;
    expect(worker.network_options).toBeUndefined();
    expect(services(composeToYaml(parseCompose(SRC))).worker.networks).toEqual(["internal"]);
  });

  it("keeps aliases and empty entries without options", () => {
    const compose = parseCompose(`services:
  web:
    image: app
    networks:
      backend:
        aliases: [api]
      frontend: {}
`);
    expect(compose.services.web.network_options).toEqual({ backend: { aliases: ["api"] } });
  });

  it("drops settings for a network the service leaves", () => {
    const stripped = stripVardoInjections(parseCompose(SRC));
    expect(services(composeToYaml(stripped)).wireguard.networks).toEqual({
      internal: null,
      mesh: { ipv4_address: "10.88.0.2" },
    });
  });
});
