import { describe, it, expect } from "vitest";

import { describeHostPortHolders, hostPortHolders, slotHostPortHolders } from "@/lib/docker/host-ports";

const holds = (services: unknown) => hostPortHolders(services as never).map((h) => h.service);

describe("hostPortHolders", () => {
  it("is empty for a Traefik-routed service that publishes nothing", () => {
    expect(holds({ web: { image: "nginx" } })).toEqual([]);
  });

  it("counts the host:container short form", () => {
    expect(holds({ web: { image: "nginx", ports: ["8080:80"] } })).toEqual(["web"]);
  });

  it("counts the bare-port short form", () => {
    expect(holds({ web: { image: "nginx", ports: ["80"] } })).toEqual(["web"]);
  });

  it("counts the long form", () => {
    expect(holds({ web: { image: "nginx", ports: [{ target: 80, published: 8080 }] } })).toEqual(["web"]);
  });

  it("counts a service on the host network", () => {
    expect(hostPortHolders({ scrypted: { image: "koush/scrypted", network_mode: "host" } } as never)).toEqual([
      { service: "scrypted", via: "host-network" },
    ]);
  });

  it("leaves out other network modes", () => {
    expect(holds({ a: { network_mode: "none" }, b: { network_mode: "service:a" }, c: { network_mode: "bridge" } })).toEqual([]);
  });

  it("names only the services that hold ports", () => {
    expect(
      holds({
        web: { image: "nginx" },
        db: { image: "postgres", ports: ["5432:5432"] },
      }),
    ).toEqual(["db"]);
  });

  it("survives an empty or malformed service map", () => {
    expect(holds({})).toEqual([]);
    expect(holds(undefined)).toEqual([]);
    expect(holds({ web: { image: "nginx", ports: [] } })).toEqual([]);
  });
});

describe("slotHostPortHolders", () => {
  it("counts ports the overlay publishes for a rotating service", () => {
    expect(
      slotHostPortHolders({ web: { image: "nginx" } } as never, { web: { ports: ["8080:80"] } } as never),
    ).toEqual([{ service: "web", via: "ports" }]);
  });

  it("ignores overlay ports on services outside the slot", () => {
    expect(
      slotHostPortHolders({ web: { image: "nginx" } } as never, { db: { ports: ["5432:5432"] } } as never),
    ).toEqual([]);
  });

  it("names a service once, preferring the host network", () => {
    expect(
      slotHostPortHolders(
        { web: { image: "nginx", network_mode: "host" } } as never,
        { web: { ports: ["8080:80"] } } as never,
      ),
    ).toEqual([{ service: "web", via: "host-network" }]);
  });
});

describe("describeHostPortHolders", () => {
  it("says how each service holds its ports", () => {
    expect(
      describeHostPortHolders([
        { service: "web", via: "ports" },
        { service: "scrypted", via: "host-network" },
      ]),
    ).toBe("web (published ports), scrypted (host network)");
  });
});
