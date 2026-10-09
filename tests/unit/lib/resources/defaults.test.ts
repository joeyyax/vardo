import { describe, it, expect } from "vitest";
import {
  FALLBACK,
  buildkitMemGb,
  describeDefaults,
  parseSizeMb,
  redisMemory,
  resolveDeployConcurrency,
  resolveTierCpus,
  resolveTierMemory,
  sizeClass,
  type HostSize,
} from "@/lib/resources/defaults";

const GiB = 1024 ** 3;
// MemTotal reads a little under the installed RAM.
const host = (cpus: number, gb: number): HostSize => ({ cpus, memoryBytes: Math.floor(gb * GiB * 0.96) });

const HOSTS = {
  "2 GB": host(1, 2),
  "8 GB": host(4, 8),
  "32 GB": host(8, 32),
  "128 GB": host(32, 128),
};

describe("rules by host size", () => {
  it.each([
    ["2 GB", "small", { critical: 1024, standard: 1024, disposable: 512 }, 1, "512m", "384mb", 2],
    ["8 GB", "medium", { critical: 2048, standard: 1024, disposable: 512 }, 2, "512m", "384mb", 2],
    ["32 GB", "large", { critical: 4096, standard: 2048, disposable: 1024 }, 4, "1024m", "768mb", 7],
    ["128 GB", "xlarge", { critical: 8192, standard: 4096, disposable: 2048 }, 6, "2048m", "1536mb", 16],
  ] as const)("%s host", (name, cls, memory, deploys, redisMem, redisMax, buildkitGb) => {
    const h = HOSTS[name];
    const mb = Math.floor(h.memoryBytes / 1024 / 1024);
    expect(sizeClass(mb).name).toBe(cls);
    for (const tier of ["critical", "standard", "disposable"] as const) {
      expect(resolveTierMemory(tier, h, {})).toEqual({ value: memory[tier], source: "detected", rule: memory[tier] });
    }
    expect(resolveDeployConcurrency(h, {}).value).toBe(deploys);
    expect(redisMemory(mb)).toEqual({ mem: redisMem, maxmemory: redisMax });
    expect(buildkitMemGb(mb)).toBe(buildkitGb);
  });

  it("matches today's fixed defaults on an 8 GB host", () => {
    for (const tier of ["critical", "standard", "disposable"] as const) {
      expect(resolveTierMemory(tier, HOSTS["8 GB"], {}).value).toBe(FALLBACK.memoryMb[tier]);
    }
    expect(resolveDeployConcurrency(HOSTS["8 GB"], {}).value).toBe(FALLBACK.deploys);
  });

  it("caps deploys at one per two CPUs", () => {
    expect(resolveDeployConcurrency(host(2, 128), {}).value).toBe(1);
    expect(resolveDeployConcurrency(host(6, 128), {}).value).toBe(3);
  });

  it("sizes CPU caps from the detected CPU count", () => {
    const h = HOSTS["32 GB"];
    expect(resolveTierCpus("standard", h, 2, {}).value).toBe(7);
    expect(resolveTierCpus("disposable", h, 2, {}).value).toBe(4);
    expect(resolveTierCpus("critical", h, 2, {}).value).toBeNull();
    expect(resolveTierCpus("standard", HOSTS["2 GB"], 2, {}).value).toBe(1);
  });
});

describe("overrides", () => {
  const h = HOSTS["128 GB"];

  it("an env var wins over the detected value", () => {
    expect(resolveTierMemory("standard", h, { VARDO_DEFAULT_MEMORY_STANDARD: "3072" })).toEqual({
      value: 3072,
      source: "override",
      rule: 4096,
    });
    expect(resolveTierCpus("standard", h, 2, { VARDO_DEFAULT_CPUS_STANDARD: "2" }).value).toBe(2);
    expect(resolveTierCpus("standard", h, 2, { VARDO_DEFAULT_CPUS_STANDARD: "0" })).toMatchObject({
      value: null,
      source: "override",
    });
    expect(resolveDeployConcurrency(h, { VARDO_MAX_DEPLOY_CONCURRENCY: "1" })).toMatchObject({ value: 1, source: "override" });
  });

  it("an env var wins over the fallback", () => {
    expect(resolveTierMemory("standard", null, { VARDO_DEFAULT_MEMORY_STANDARD: "3072" }).source).toBe("override");
    expect(resolveDeployConcurrency(null, { VARDO_MAX_DEPLOY_CONCURRENCY: "5" }).value).toBe(5);
  });

  it("ignores invalid overrides", () => {
    expect(resolveTierMemory("disposable", h, { VARDO_DEFAULT_MEMORY_DISPOSABLE: "8" }).source).toBe("detected");
    expect(resolveDeployConcurrency(h, { VARDO_MAX_DEPLOY_CONCURRENCY: "banana" }).source).toBe("detected");
    expect(resolveDeployConcurrency(h, { VARDO_MAX_DEPLOY_CONCURRENCY: "0" }).value).toBe(1);
  });
});

describe("failed detection", () => {
  it("falls back to the fixed defaults", () => {
    for (const tier of ["critical", "standard", "disposable"] as const) {
      expect(resolveTierMemory(tier, null, {})).toMatchObject({ value: FALLBACK.memoryMb[tier], source: "fallback" });
    }
    expect(resolveDeployConcurrency(null, {})).toMatchObject({ value: 2, source: "fallback" });
  });

  it("sizes CPU caps from the console's own CPU count", () => {
    expect(resolveTierCpus("standard", null, 4, {})).toMatchObject({ value: 3, source: "fallback" });
    expect(resolveTierCpus("disposable", null, 4, {})).toMatchObject({ value: 2, source: "fallback" });
  });

  it("reports every default as fallback with no env", () => {
    expect(describeDefaults(null, 4, {}).every((d) => d.source === "fallback")).toBe(true);
  });
});

describe("installer values", () => {
  const h = HOSTS["32 GB"];
  const row = (env: Record<string, string>, running?: { redisMemMb: number | null }) =>
    describeDefaults(h, 8, env, { buildkitMemMb: null, redisMaxmemoryMb: null, redisMemMb: running?.redisMemMb ?? null }).find(
      (d) => d.key === "redisMem",
    )!;

  it("counts a value matching the rule as detected", () => {
    expect(row({ VARDO_REDIS_MEM: "1024m" })).toMatchObject({ source: "detected", value: 1024, rule: 1024 });
  });

  it("counts a different value as an override", () => {
    expect(row({ VARDO_REDIS_MEM: "1g" }).source).toBe("detected");
    expect(row({ VARDO_REDIS_MEM: "768m" }).source).toBe("override");
  });

  it("treats unset as compose's default", () => {
    expect(row({})).toMatchObject({ source: "fallback", value: 512, rule: 1024 });
  });

  it("carries the running limit", () => {
    expect(row({}, { redisMemMb: 512 }).running).toBe(512);
  });
});

describe("parseSizeMb", () => {
  it.each([
    ["512m", 512],
    ["384mb", 384],
    ["4g", 4096],
    ["1.5gb", 1536],
    ["1048576k", 1024],
    ["junk", null],
  ])("%s", (input, mb) => {
    expect(parseSizeMb(input)).toBe(mb);
  });
});
