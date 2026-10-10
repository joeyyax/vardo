// Traefik is pinned to a minor; bump it deliberately.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";

const services = (
  YAML.parse(readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8")) as {
    services: Record<string, { image?: string }>;
  }
).services;

describe("stack image pins", () => {
  it("pins Traefik to a minor", () => {
    expect(services.traefik.image).toMatch(/^traefik:v3\.\d+(\.\d+)?$/);
  });
});
