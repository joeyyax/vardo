import { describe, expect, it } from "vitest";
import { parseCompose } from "@/lib/docker/compose-parse";
import { normalizeCompose } from "@/lib/docker/compose-normalize";
import {
  injectNetwork,
  injectResourceLimits,
  injectTraefikLabels,
  stripVardoInjections,
} from "@/lib/docker/compose-inject";
import { isSharedService } from "@/lib/docker/slot-partition";
import type { ComposeFile } from "@/lib/docker/compose-types";

const SRC = `services:
  web:
    image: nginx
  db:
    image: postgres:17
    x-vardo-shared: true
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`;

/**
 * The deploy path rewrites services several times before the partition reads
 * the marker. A transform that rebuilds a service without spreading it would
 * silently drop the marker and rotate a database.
 */
describe("x-vardo-shared through the deploy transforms", () => {
  const cases: Array<[string, (c: ComposeFile) => ComposeFile]> = [
    ["normalizeCompose", (c) => normalizeCompose(c, { keepHostPorts: true }).compose],
    ["injectNetwork", (c) => injectNetwork(c, "vardo-network")],
    ["stripVardoInjections", (c) => stripVardoInjections(c, "vardo-network")],
    ["injectResourceLimits", (c) => injectResourceLimits(c, { memoryLimit: 512 })],
    [
      "injectTraefikLabels",
      (c) => injectTraefikLabels(c, { projectName: "demo", domain: "x.test", containerPort: 80 }),
    ],
  ];

  for (const [name, transform] of cases) {
    it(`survives ${name}`, () => {
      const out = transform(parseCompose(SRC));
      expect(isSharedService(out.services.db)).toBe(true);
      expect(isSharedService(out.services.web)).toBe(false);
    });
  }
});
