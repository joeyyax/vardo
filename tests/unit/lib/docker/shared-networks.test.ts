import { describe, expect, it } from "vitest";
import {
  networkCreateArgs,
  sharedNetworkName,
  sharedNetworks,
} from "@/lib/docker/shared-networks";
import { parseCompose } from "@/lib/docker/compose-parse";

const SRC = `name: vardo
services:
  frontend:
    image: app
    networks: [internal, mesh, vardo-network]
  postgres:
    image: postgres:17
    x-vardo-shared: true
    networks: [internal]
  wireguard:
    image: wg
    x-vardo-shared: true
    networks: [internal, mesh, vardo-network]
  worker:
    image: app
    networks: [private]
networks:
  internal:
  private:
  mesh:
    ipam:
      config:
        - subnet: 10.88.0.0/24
  vardo-network:
    external: true
`;

describe("sharedNetworks", () => {
  it("claims networks a shared service attaches to", () => {
    expect([...sharedNetworks(parseCompose(SRC))].sort()).toEqual(["internal", "mesh"]);
  });

  it("leaves a network only rotating services use alone", () => {
    expect(sharedNetworks(parseCompose(SRC))).not.toContain("private");
  });

  it("ignores an already-external network, which needs no help", () => {
    expect(sharedNetworks(parseCompose(SRC))).not.toContain("vardo-network");
  });

  it("claims nothing when no service is shared", () => {
    const plain = parseCompose(`services:
  web:
    image: app
    networks: [internal]
networks:
  internal:
`);
    expect(sharedNetworks(plain).size).toBe(0);
  });
});

describe("sharedNetworkName", () => {
  it("uses the pinned compose name, matching what the running stack created", () => {
    expect(sharedNetworkName(parseCompose(SRC), "mesh", "vardo-production")).toBe("vardo_mesh");
  });

  it("falls back to the app-and-environment prefix when nothing is pinned", () => {
    const c = parseCompose(SRC.replace("name: vardo\n", ""));
    expect(sharedNetworkName(c, "mesh", "shop-production")).toBe("shop-production_mesh");
  });
});

describe("networkCreateArgs", () => {
  it("carries a pinned subnet, without which the recreated network drifts", () => {
    const c = parseCompose(SRC);
    expect(networkCreateArgs(c.networks!.mesh, "vardo_mesh")).toEqual([
      "network", "create", "--subnet", "10.88.0.0/24", "vardo_mesh",
    ]);
  });

  it("is a plain create when the compose pins nothing", () => {
    const c = parseCompose(SRC);
    expect(networkCreateArgs(c.networks!.internal, "vardo_internal")).toEqual([
      "network", "create", "vardo_internal",
    ]);
  });
});

describe("a network declared with no config", () => {
  it("is still claimed — `internal:` parses to null, which is a real declaration", () => {
    const c = parseCompose(`name: vardo
services:
  web:
    image: app
    networks: [internal]
  db:
    image: postgres
    x-vardo-shared: true
    networks: [internal]
networks:
  internal:
`);
    expect(c.networks!.internal).toBeNull();
    expect([...sharedNetworks(c)]).toEqual(["internal"]);
    expect("internal" in c.networks!).toBe(true);
  });
});
