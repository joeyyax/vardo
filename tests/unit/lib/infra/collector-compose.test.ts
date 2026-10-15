import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabled: () => false }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));

const { applyCollectorGpu } = await import("@/lib/infra/collector-compose");
const { parseAndSanitize } = await import("@/lib/docker/deploy-steps/prepare-repo");
const { composeToYaml } = await import("@/lib/docker/compose-parse");

const template = (YAML.parse(readFileSync(join(process.cwd(), "templates/collector.yaml"), "utf-8")) as { composeContent: string }).composeContent;

describe("the collector's compose", () => {
  it("is the template unchanged on a host without a GPU", () => {
    expect(applyCollectorGpu(template, false)).toBe(template);
    expect(YAML.parse(template).services.collector.pid).toBeUndefined();
  });

  it("runs in the host PID namespace on a GPU host, and the deploy keeps it", () => {
    const yaml = applyCollectorGpu(template, true);
    expect(YAML.parse(yaml).services.collector.pid).toBe("host");

    const lines: string[] = [];
    const compose = parseAndSanitize(yaml, (m) => lines.push(m), { orgTrusted: true, systemManaged: true });
    expect(compose.services.collector.pid).toBe("host");
    expect(YAML.parse(composeToYaml(compose)).services.collector.pid).toBe("host");
    expect(lines.some((l) => l.includes("does not apply"))).toBe(false);
  });

  it("sets the API-only labels Vardo matches on", () => {
    const env = YAML.parse(template).services.collector.environment;
    expect(JSON.parse(env.COLLECTOR_CONTAINERS__API_LABELS)).toEqual(["vardo.organization", "vardo.project.id", "host.*"]);
  });
});
