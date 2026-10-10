import { describe, it, expect } from "vitest";
import {
  FALLBACK,
  buildkitMemGb,
  describeDefaults,
  envLock,
  parseAdminSettings,
  parseSizeMb,
  redisMemory,
  resolveDeployConcurrency,
  resolveTierCpus,
  resolveTierMemory,
  sizeClass,
  validateAdminValue,
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
    ["2 GB", "small", { critical: 1024, standard: 1024, disposable: 512 }, 1, "512m", "320mb", 4],
    ["8 GB", "medium", { critical: 2048, standard: 1024, disposable: 512 }, 2, "512m", "320mb", 4],
    ["32 GB", "large", { critical: 4096, standard: 2048, disposable: 1024 }, 4, "1024m", "640mb", 7],
    ["128 GB", "xlarge", { critical: 8192, standard: 4096, disposable: 2048 }, 6, "2048m", "1280mb", 16],
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

describe("admin values", () => {
  const big = host(32, 128);

  it("win over the rule and the fallback", () => {
    expect(resolveTierMemory("standard", big, {}, 3072)).toEqual({ value: 3072, source: "admin", rule: 4096 });
    expect(resolveTierMemory("standard", null, {}, 3072).source).toBe("admin");
    expect(resolveTierCpus("disposable", big, 4, {}, 2)).toMatchObject({ value: 2, source: "admin" });
    expect(resolveDeployConcurrency(big, {}, 9)).toMatchObject({ value: 9, source: "admin" });
  });

  it("lose to an env var", () => {
    const env = { VARDO_DEFAULT_MEMORY_STANDARD: "1536", VARDO_MAX_DEPLOY_CONCURRENCY: "3" };
    expect(resolveTierMemory("standard", big, env, 3072)).toMatchObject({ value: 1536, source: "override" });
    expect(resolveDeployConcurrency(big, env, 9)).toMatchObject({ value: 3, source: "override" });
  });

  it("cap CPUs at the host's count", () => {
    expect(resolveTierCpus("standard", host(4, 16), 4, {}, 12).value).toBe(4);
  });

  it("show up in describeDefaults, editable only where an admin can set them", () => {
    const rows = describeDefaults(big, 32, {}, undefined, { memoryCritical: 6144, cpusStandard: 8 });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.memoryCritical).toMatchObject({ value: 6144, source: "admin", rule: 8192, editable: true });
    expect(by.cpusStandard).toMatchObject({ value: 8, source: "admin", editable: true });
    expect(by.cpusCritical.editable).toBe(false);
    expect(by.redisMem.editable).toBe(false);
    expect(by.buildkitMem.editable).toBe(false);
  });
});

describe("validateAdminValue", () => {
  it("holds memory to at least 128 MB", () => {
    expect(validateAdminValue("memoryStandard", 127, 8)).toMatch(/at least 128/);
    expect(validateAdminValue("memoryStandard", 128, 8)).toBeNull();
    expect(validateAdminValue("memoryStandard", 512.5, 8)).toMatch(/whole number/);
  });

  it("holds CPUs between 0.25 and the host's count", () => {
    expect(validateAdminValue("cpusStandard", 0.2, 8)).toMatch(/at least 0.25/);
    expect(validateAdminValue("cpusStandard", 0.25, 8)).toBeNull();
    expect(validateAdminValue("cpusDisposable", 8, 8)).toBeNull();
    expect(validateAdminValue("cpusDisposable", 8.5, 8)).toMatch(/more than the host's 8/);
  });

  it("holds deploys at once to 1 through 32", () => {
    expect(validateAdminValue("deployConcurrency", 0, 8)).toMatch(/1 to 32/);
    expect(validateAdminValue("deployConcurrency", 1, 8)).toBeNull();
    expect(validateAdminValue("deployConcurrency", 32, 8)).toBeNull();
    expect(validateAdminValue("deployConcurrency", 33, 8)).toMatch(/1 to 32/);
    expect(validateAdminValue("deployConcurrency", 2.5, 8)).toMatch(/1 to 32/);
  });

  it("refuses a non-number", () => {
    expect(validateAdminValue("memoryStandard", NaN, 8)).toMatch(/number/);
  });
});

describe("parseAdminSettings", () => {
  it("keeps valid values and drops the rest", () => {
    expect(
      parseAdminSettings({ memoryStandard: 2048, memoryCritical: 10, cpusCritical: 2, deployConcurrency: "4", bogus: 1 }),
    ).toEqual({ memoryStandard: 2048 });
    expect(parseAdminSettings(null)).toEqual({});
  });
});

describe("envLock", () => {
  it("names the env var that sets a value", () => {
    expect(envLock("memoryStandard", { VARDO_DEFAULT_MEMORY_STANDARD: "1536" })).toBe("VARDO_DEFAULT_MEMORY_STANDARD");
    expect(envLock("cpusDisposable", { VARDO_DEFAULT_CPUS_DISPOSABLE: "0" })).toBe("VARDO_DEFAULT_CPUS_DISPOSABLE");
    expect(envLock("deployConcurrency", { VARDO_MAX_DEPLOY_CONCURRENCY: "3" })).toBe("VARDO_MAX_DEPLOY_CONCURRENCY");
  });

  it("ignores unset and unusable env values", () => {
    expect(envLock("memoryStandard", {})).toBeNull();
    expect(envLock("memoryStandard", { VARDO_DEFAULT_MEMORY_STANDARD: "32" })).toBeNull();
    expect(envLock("deployConcurrency", { VARDO_MAX_DEPLOY_CONCURRENCY: "lots" })).toBeNull();
  });
});

describe("BuildKit cache ceiling", () => {
  const GIB = 1024 ** 3;
  const row = (env: Record<string, string>, disk: number | null) =>
    describeDefaults(HOSTS["32 GB"], 8, env, undefined, {}, disk).find((d) => d.key === "buildkitCache")!;

  it("is the rule in MiB, not bytes", () => {
    expect(row({}, 250 * GIB).rule).toBe(25 * 1024);
  });

  it("counts the installer's bytes as detected when they match the disk's rule", () => {
    expect(row({ VARDO_BUILDKIT_CACHE_MAX: String(25 * GIB) }, 250 * GIB)).toMatchObject({ source: "detected", value: 25 * 1024 });
  });

  it("reads a pinned value with a unit as an override", () => {
    expect(row({ VARDO_BUILDKIT_CACHE_MAX: "20GB" }, 250 * GIB)).toMatchObject({ source: "override", value: 20 * 1024 });
  });

  it("falls back to 10 GiB with nothing set", () => {
    expect(row({}, null)).toMatchObject({ source: "fallback", value: 10 * 1024 });
  });
});
