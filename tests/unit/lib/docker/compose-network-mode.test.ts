import { describe, it, expect } from "vitest";
import { normalizeNamedNetworkModes } from "@/lib/docker/compose-validate";
import { parseCompose, composeToYaml } from "@/lib/docker/compose-parse";
import type { ComposeFile, ComposeService } from "@/lib/docker/compose-types";

function makeCompose(
  services: Record<string, Partial<ComposeService>>,
  networks?: Record<string, unknown>,
): ComposeFile {
  return {
    services: Object.fromEntries(
      Object.entries(services).map(([name, svc]) => [name, { name, ...svc }]),
    ),
    ...(networks ? { networks } : {}),
  };
}

describe("normalizeNamedNetworkModes", () => {
  it("moves a network name from network_mode into networks", () => {
    const result = normalizeNamedNetworkModes(
      makeCompose({ n8n: { image: "n8nio/n8n", network_mode: "vardo-network" } }),
    );

    expect(result.services.n8n.network_mode).toBeUndefined();
    expect(result.services.n8n.networks).toEqual(["vardo-network"]);
  });

  it("declares the moved network external", () => {
    const result = normalizeNamedNetworkModes(
      makeCompose({ n8n: { image: "n8nio/n8n", network_mode: "vardo-network" } }),
    );

    expect(result.networks).toEqual({ "vardo-network": { external: true } });
  });

  it("leaves namespace modes alone", () => {
    for (const nm of ["host", "none", "bridge", "service:gluetun", "container:abc"]) {
      const result = normalizeNamedNetworkModes(
        makeCompose({ app: { image: "app", network_mode: nm } }),
      );
      expect(result.services.app.network_mode).toBe(nm);
      expect(result.services.app.networks).toBeUndefined();
    }
  });

  it("returns the input untouched when nothing needs moving", () => {
    const compose = makeCompose({ app: { image: "app", network_mode: "host" } });
    expect(normalizeNamedNetworkModes(compose)).toBe(compose);
  });

  it("merges into an existing networks list without duplicating", () => {
    const result = normalizeNamedNetworkModes(
      makeCompose({
        app: { image: "app", networks: ["vardo-network", "internal"], network_mode: "vardo-network" },
      }),
    );

    expect(result.services.app.networks).toEqual(["vardo-network", "internal"]);
  });

  it("keeps an existing top-level declaration for the same network", () => {
    const result = normalizeNamedNetworkModes(
      makeCompose(
        { app: { image: "app", network_mode: "shared" } },
        { shared: { name: "shared-legacy", external: true } },
      ),
    );

    expect(result.networks).toEqual({ shared: { name: "shared-legacy", external: true } });
  });

  it("handles a mix of namespace and named modes across services", () => {
    const result = normalizeNamedNetworkModes(
      makeCompose({
        gluetun: { image: "gluetun", network_mode: "bridge" },
        transmission: { image: "transmission", network_mode: "service:gluetun" },
        web: { image: "web", network_mode: "vardo-network" },
        media: { image: "media", network_mode: "media-net" },
      }),
    );

    expect(result.services.gluetun.network_mode).toBe("bridge");
    expect(result.services.transmission.network_mode).toBe("service:gluetun");
    expect(result.services.web.networks).toEqual(["vardo-network"]);
    expect(result.services.media.networks).toEqual(["media-net"]);
    expect(result.networks).toEqual({
      "vardo-network": { external: true },
      "media-net": { external: true },
    });
  });

  it("does not mutate the input", () => {
    const compose = makeCompose({ app: { image: "app", network_mode: "vardo-network" } });
    normalizeNamedNetworkModes(compose);

    expect(compose.services.app.network_mode).toBe("vardo-network");
    expect(compose.networks).toBeUndefined();
  });
});

describe("parseCompose — named network_mode", () => {
  const stored = `
services:
  n8n:
    image: n8nio/n8n:2.25.7
    network_mode: vardo-network
    labels:
      traefik.enable: "true"
`;

  it("applies the transform on the way out of the parser", () => {
    const compose = parseCompose(stored);

    expect(compose.services.n8n.network_mode).toBeUndefined();
    expect(compose.services.n8n.networks).toEqual(["vardo-network"]);
    expect(compose.networks).toEqual({ "vardo-network": { external: true } });
  });

  it("serializes back to valid compose", () => {
    const yaml = composeToYaml(parseCompose(stored));

    expect(yaml).not.toContain("network_mode");
    expect(parseCompose(yaml).services.n8n.networks).toEqual(["vardo-network"]);
  });

  it("is idempotent", () => {
    const once = parseCompose(stored);
    const twice = parseCompose(composeToYaml(once));

    expect(twice).toEqual(once);
  });
});
