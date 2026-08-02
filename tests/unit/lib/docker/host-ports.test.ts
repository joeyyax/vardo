import { describe, it, expect } from "vitest";

import { publishesHostPorts } from "@/lib/docker/host-ports";

describe("publishesHostPorts", () => {
  it("is false for a Traefik-routed service that publishes nothing", () => {
    expect(publishesHostPorts({ web: { image: "nginx" } } as never)).toBe(false);
  });

  it("is true for the host:container short form", () => {
    expect(publishesHostPorts({ web: { image: "nginx", ports: ["8080:80"] } } as never)).toBe(true);
  });

  // A bare port still takes an ephemeral host port, so it is exclusive too.
  it("is true for the bare-port short form", () => {
    expect(publishesHostPorts({ web: { image: "nginx", ports: ["80"] } } as never)).toBe(true);
  });

  it("is true for the long form", () => {
    expect(
      publishesHostPorts({ web: { image: "nginx", ports: [{ target: 80, published: 8080 }] } } as never),
    ).toBe(true);
  });

  it("is true when any one service of several publishes", () => {
    expect(
      publishesHostPorts({
        web: { image: "nginx" },
        db: { image: "postgres", ports: ["5432:5432"] },
      } as never),
    ).toBe(true);
  });

  it("survives an empty or malformed service map", () => {
    expect(publishesHostPorts({} as never)).toBe(false);
    expect(publishesHostPorts(undefined as never)).toBe(false);
    expect(publishesHostPorts({ web: { image: "nginx", ports: [] } } as never)).toBe(false);
  });
});
