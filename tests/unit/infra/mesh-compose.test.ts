import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MESH_NETWORK_SUBNET } from "@/lib/mesh/constants";

// Nothing on the mesh network has a fixed address (#1140): Docker hands one out to whoever starts first after a reboot.

type Compose = {
  services: Record<string, { environment?: Record<string, unknown>; networks?: Record<string, { ipv4_address?: string } | null> | string[] }>;
  networks: { mesh: { ipam: { config: { subnet: string }[] } } };
};

const compose = parse(readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8")) as Compose;

describe("mesh network in docker-compose.yml", () => {
  it("gives no service a fixed mesh address", () => {
    const fixed = Object.entries(compose.services)
      .filter(([, s]) => s.networks && !Array.isArray(s.networks) && s.networks.mesh?.ipv4_address)
      .map(([name]) => name);
    expect(fixed).toEqual([]);
  });

  it("passes no fixed WireGuard gateway", () => {
    const withGateway = Object.entries(compose.services)
      .filter(([, s]) => s.environment && "WIREGUARD_GATEWAY" in s.environment)
      .map(([name]) => name);
    expect(withGateway).toEqual([]);
  });

  it("declares the subnet the console looks for", () => {
    expect(compose.networks.mesh.ipam.config[0].subnet).toBe(MESH_NETWORK_SUBNET);
  });
});
