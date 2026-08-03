import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";

import { parseCompose } from "@/lib/docker/compose-parse";
import {
  stripVardoInjections,
  buildVardoOverlay,
  getTraefikRoutedServices,
} from "@/lib/docker/compose-inject";

// Core services carry no domain, so resolve-compose injects nothing: the shared
// network has to come from the template and survive the split into
// docker-compose.yml + docker-compose.override.yml.

const NETWORK = "vardo-network";

function rawTemplate(name: string): Record<string, unknown> {
  const path = join(process.cwd(), "templates", `${name}.yaml`);
  return YAML.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** The two compose files a deploy would write for a domainless core service. */
function deployedFiles(name: string) {
  const compose = parseCompose(rawTemplate(name).composeContent as string);
  return {
    compose,
    bare: stripVardoInjections(compose, NETWORK),
    overlay: buildVardoOverlay({ fullCompose: compose, networkName: NETWORK }),
  };
}

/** Service each client resolves on the shared network. */
const ATTACHED: Record<string, string> = {
  cadvisor: "cadvisor",
  loki: "loki",
  promtail: "promtail",
  glitchtip: "glitchtip",
};

describe("core service templates — shared network", () => {
  for (const [template, service] of Object.entries(ATTACHED)) {
    describe(template, () => {
      it("declares the network as external", () => {
        const { compose } = deployedFiles(template);
        expect(compose.networks?.[NETWORK]).toEqual({ external: true });
      });

      it("has no Traefik-routed service, so injection never runs", () => {
        const { compose } = deployedFiles(template);
        expect(getTraefikRoutedServices(compose).size).toBe(0);
      });

      it("attaches the service the client resolves", () => {
        const { compose } = deployedFiles(template);
        expect(compose.services[service].networks).toContain(NETWORK);
      });

      it("survives into the override, and only the override", () => {
        const { bare, overlay } = deployedFiles(template);
        expect(overlay.networks?.[NETWORK]).toEqual({ external: true });
        expect(overlay.services[service].networks).toEqual([NETWORK]);
        // Declaring it in both files makes Compose create a second network.
        expect(bare.networks?.[NETWORK]).toBeUndefined();
        expect(bare.services[service].networks ?? []).not.toContain(NETWORK);
      });
    });
  }

  it("keeps GlitchTip's backing services off the shared network", () => {
    const { overlay } = deployedFiles("glitchtip");
    for (const service of ["postgres", "redis", "worker"]) {
      expect(overlay.services[service].networks).toBeUndefined();
    }
  });

  it("keeps GlitchTip on its project network so postgres and redis resolve", () => {
    const { bare } = deployedFiles("glitchtip");
    expect(bare.services.glitchtip.networks).toEqual(["default"]);
  });

  it("points Promtail at Loki's compose service name", () => {
    // container_name is stripped for blue/green, so only the service name resolves.
    const configs = (rawTemplate("promtail").composeContent as string).includes(
      "http://loki:3100/loki/api/v1/push",
    );
    expect(configs).toBe(true);
  });
});
