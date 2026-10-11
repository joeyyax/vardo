import { describe, it, expect } from "vitest";
import {
  FALLBACK,
  buildkitMemGb,
  deployConcurrency,
  describeDefaults,
  installedGiB,
  envLock,
  parseAdminSettings,
  parseSizeMb,
  redisMemory,
  resolveDeployConcurrency,
  resolveTierCpus,
  resolveTierMemory,
  redisMemMb,
  roundMiB,
  tierMemoryRuleMb,
  traefikMemMb,
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

// Bands before formulas, kept to show what changed.
const BANDS = [
  { belowGiB: 6, memory: { critical: 1024, standard: 1024, disposable: 512 }, deploys: 1, redis: 512 },
  { belowGiB: 24, memory: { critical: 2048, standard: 1024, disposable: 512 }, deploys: 2, redis: 512 },
  { belowGiB: 96, memory: { critical: 4096, standard: 2048, disposable: 1024 }, deploys: 4, redis: 1024 },
  { belowGiB: Infinity, memory: { critical: 8192, standard: 4096, disposable: 2048 }, deploys: 6, redis: 2048 },
];

function before(h: HostSize) {
  const mb = Math.floor(h.memoryBytes / 1024 / 1024);
  const band = BANDS.find((b) => mb < b.belowGiB * 1024)!;
  return { ...band.memory, deploys: Math.max(1, Math.min(band.deploys, Math.floor(h.cpus / 2))), redis: band.redis };
}

function after(h: HostSize) {
  const mb = Math.floor(h.memoryBytes / 1024 / 1024);
  return {
    critical: resolveTierMemory("critical", h, {}).value,
    standard: resolveTierMemory("standard", h, {}).value,
    disposable: resolveTierMemory("disposable", h, {}).value,
    deploys: resolveDeployConcurrency(h, {}).value,
    redis: redisMemMb(mb),
  };
}

describe("formulas by host size", () => {
  // Host, cores, then [critical, standard, disposable, deploys, redis] before and after.
  it.each([
    [4, 2, [1024, 1024, 512, 1, 512], [1024, 1024, 512, 1, 512]],
    [8, 4, [2048, 1024, 512, 2, 512], [2048, 1024, 512, 2, 512]],
    [16, 4, [2048, 1024, 512, 2, 512], [2048, 1024, 512, 2, 512]],
    [32, 8, [4096, 2048, 1024, 4, 1024], [4096, 2048, 1024, 4, 1024]],
    [48, 12, [4096, 2048, 1024, 4, 1024], [6144, 3072, 1536, 6, 1536]],
    [64, 16, [4096, 2048, 1024, 4, 1024], [8192, 4096, 2048, 6, 2048]],
    [128, 32, [8192, 4096, 2048, 6, 2048], [8192, 4096, 2048, 6, 2048]],
    [256, 64, [8192, 4096, 2048, 6, 2048], [8192, 4096, 2048, 6, 2048]],
  ] as const)("%i GiB, %i cores", (gb, cpus, was, now) => {
    const h = host(cpus, gb);
    const shape = ([critical, standard, disposable, deploys, redis]: readonly number[]) => ({ critical, standard, disposable, deploys, redis });
    expect(before(h)).toEqual(shape(was));
    expect(after(h)).toEqual(shape(now));
  });

  it("reports the formula as the detected rule", () => {
    expect(resolveTierMemory("standard", HOSTS["32 GB"], {})).toEqual({ value: 2048, source: "detected", rule: 2048 });
  });

  // MemTotal in MiB for a host with this much installed RAM.
  const mt = (gib: number) => Math.floor(gib * 1024 * 0.96);

  it("reads installed RAM from MemTotal", () => {
    expect(installedGiB(mt(8))).toBe(8);
    expect(installedGiB(mt(16))).toBe(16);
    expect(installedGiB(8192)).toBe(8);
    expect(installedGiB(8355)).toBe(8);
    expect(installedGiB(8356)).toBe(9);
  });

  it("never sizes below the bands on round hosts", () => {
    for (const gib of [2, 4, 6, 8, 16, 24, 32, 48, 64, 96, 128, 256]) {
      const h = host(Math.max(1, gib / 2), gib);
      const was = before(h);
      const now = after(h);
      expect(now.critical).toBeGreaterThanOrEqual(was.critical);
      expect(now.standard).toBeGreaterThanOrEqual(was.standard);
      expect(now.disposable).toBeGreaterThanOrEqual(was.disposable);
      expect(now.redis).toBeGreaterThanOrEqual(was.redis);
      expect(now.deploys).toBeGreaterThanOrEqual(was.deploys);
    }
  });

  it("holds critical between 1 GiB (2 GiB from 6 GiB of RAM) and 8 GiB at RAM/8", () => {
    expect(tierMemoryRuleMb("critical", mt(4))).toBe(1024);
    expect(tierMemoryRuleMb("critical", mt(5))).toBe(1024);
    expect(tierMemoryRuleMb("critical", mt(6))).toBe(2048);
    expect(tierMemoryRuleMb("critical", mt(8))).toBe(2048);
    expect(tierMemoryRuleMb("critical", mt(16))).toBe(2048);
    expect(tierMemoryRuleMb("critical", mt(17))).toBe(2176);
    expect(tierMemoryRuleMb("critical", mt(64))).toBe(8192);
    expect(tierMemoryRuleMb("critical", mt(65))).toBe(8192);
  });

  it("holds standard between 1 and 4 GiB at RAM/16", () => {
    expect(tierMemoryRuleMb("standard", mt(8))).toBe(1024);
    expect(tierMemoryRuleMb("standard", mt(16))).toBe(1024);
    expect(tierMemoryRuleMb("standard", mt(17))).toBe(1088);
    expect(tierMemoryRuleMb("standard", mt(64))).toBe(4096);
    expect(tierMemoryRuleMb("standard", mt(1000))).toBe(4096);
  });

  it("keeps disposable at half of standard, at least 512 MiB", () => {
    expect(tierMemoryRuleMb("disposable", mt(2))).toBe(512);
    expect(tierMemoryRuleMb("disposable", mt(32))).toBe(1024);
    expect(tierMemoryRuleMb("disposable", mt(1000))).toBe(2048);
  });

  it("holds Redis between 512 MiB and 2 GiB at RAM/32", () => {
    expect(redisMemMb(mt(8))).toBe(512);
    expect(redisMemMb(mt(16))).toBe(512);
    expect(redisMemMb(mt(17))).toBe(576);
    expect(redisMemMb(mt(64))).toBe(2048);
    expect(redisMemMb(mt(1000))).toBe(2048);
  });

  it("writes Redis maxmemory at 5/8 of the limit and keeps BuildKit at a quarter of RAM", () => {
    expect(redisMemory(mt(16))).toEqual({ mem: "512m", maxmemory: "320mb" });
    expect(redisMemory(mt(32))).toEqual({ mem: "1024m", maxmemory: "640mb" });
    expect(buildkitMemGb(31457)).toBe(7);
  });

  it("rounds to the nearest 64 MiB", () => {
    expect(roundMiB(991)).toBe(960);
    expect(roundMiB(992)).toBe(1024);
    expect(roundMiB(1023.9)).toBe(1024);
  });

  it("allows one deploy per two cores and per 4 GiB installed, from 1 to 6", () => {
    const at = (cpus: number, gib: number) => deployConcurrency(host(cpus, gib));
    expect(at(1, 2)).toBe(1);
    expect(at(8, 7)).toBe(1);
    expect(at(8, 8)).toBe(2);
    expect(at(3, 64)).toBe(1);
    expect(at(64, 23)).toBe(5);
    expect(at(64, 24)).toBe(6);
    expect(at(64, 512)).toBe(6);
  });

  it("allows two deploys from 4 cores and 8 GB installed", () => {
    for (const cpus of [4, 5, 8, 64]) for (const gib of [8, 9, 12, 512]) expect(deployConcurrency(host(cpus, gib))).toBeGreaterThanOrEqual(2);
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
    describeDefaults(h, 8, env, { buildkitMemMb: null, redisMaxmemoryMb: null, redisMemMb: running?.redisMemMb ?? null, traefikMemMb: null }).find(
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

  it("matches maxmemory to the 5/8 install.sh writes", () => {
    const max = describeDefaults(h, 8, { VARDO_REDIS_MAXMEMORY: "640mb" }).find((d) => d.key === "redisMaxmemory")!;
    expect(max).toMatchObject({ source: "detected", rule: 640 });
    expect(describeDefaults(h, 8, {}).find((d) => d.key === "redisMaxmemory")).toMatchObject({ value: 320, source: "fallback" });
  });

  it("carries the running limit", () => {
    expect(row({}, { redisMemMb: 512 }).running).toBe(512);
  });
});

describe("Traefik memory", () => {
  const mt = (gib: number) => Math.floor(gib * 1024 * 0.96);
  const traefik = (h: HostSize | null, env: Record<string, string> = {}, running: number | null = null) =>
    describeDefaults(h, 8, env, { buildkitMemMb: null, redisMemMb: null, redisMaxmemoryMb: null, traefikMemMb: running }).find(
      (d) => d.key === "traefikMem",
    );

  it.each([
    [2, 512],
    [8, 512],
    [16, 512],
    [17, 576],
    [24, 768],
    [32, 1024],
    [64, 2048],
    [256, 2048],
  ])("sizes %i GiB of RAM to %i MiB", (gib, mb) => {
    expect(traefikMemMb(mt(gib))).toBe(mb);
  });

  it("is an installer row with the running limit, read from VARDO_TRAEFIK_MEM", () => {
    expect(traefik(HOSTS["32 GB"], { VARDO_TRAEFIK_MEM: "1024m" }, 256)).toMatchObject({
      envVar: "VARDO_TRAEFIK_MEM",
      installer: true,
      editable: false,
      source: "detected",
      value: 1024,
      rule: 1024,
      running: 256,
    });
  });

  it("falls back to compose's 512m when unset", () => {
    expect(traefik(HOSTS["32 GB"])).toMatchObject({ source: "fallback", value: 512, rule: 1024 });
    expect(traefik(null)).toMatchObject({ source: "fallback", value: 512, rule: 512 });
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
    expect(row({}, 250 * GIB).rule).toBe(31 * 1024);
  });

  it("counts the installer's bytes as detected when they match the disk's rule", () => {
    expect(row({ VARDO_BUILDKIT_CACHE_MAX: String(31 * GIB) }, 250 * GIB)).toMatchObject({ source: "detected", value: 31 * 1024 });
  });

  it("reads a pinned value with a unit as an override", () => {
    expect(row({ VARDO_BUILDKIT_CACHE_MAX: "20GB" }, 250 * GIB)).toMatchObject({ source: "override", value: 20 * 1024 });
  });

  it("falls back to 10 GiB with nothing set", () => {
    expect(row({}, null)).toMatchObject({ source: "fallback", value: 10 * 1024 });
  });
});
