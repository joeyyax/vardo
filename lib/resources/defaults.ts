// Sizing defaults from the host's CPU count and memory. install.sh mirrors the Redis, Traefik and BuildKit rules.

export type QosTier = "critical" | "standard" | "disposable";

/** What Docker's /info reports. */
export type HostSize = { cpus: number; memoryBytes: number };

/** Detected: the rule applied to the host. Override: an env var set it. Admin: set in System settings. Fallback: the host couldn't be read. */
export type DefaultSource = "detected" | "override" | "admin" | "fallback";

const MIB_STEP = 64;

/** Whole MiB to the nearest 64. install.sh does the same integer math. */
export function roundMiB(mb: number): number {
  return Math.floor((Math.floor(mb) + MIB_STEP / 2) / MIB_STEP) * MIB_STEP;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Per-tier memory formula: a share of RAM between a floor and a ceiling, in MiB. Disposable is half of standard. */
export const TIER_MEMORY_FORMULA = {
  critical: { divisor: 8, minMb: 1024, maxMb: 8192, largeHostGiB: 6, largeHostMinMb: 2048 },
  standard: { divisor: 16, minMb: 1024, maxMb: 4096 },
  disposable: { minMb: 512 },
} as const;

export const DEPLOYS_FORMULA = { coresPer: 2, gibPer: 4, min: 1, max: 6 } as const;

export const REDIS_FORMULA = { divisor: 32, minMb: 512, maxMb: 2048 } as const;

export const TRAEFIK_FORMULA = { divisor: 32, minMb: 512, maxMb: 2048 } as const;

/** The values used when the host can't be read: Vardo's fixed defaults before sizing. */
export const FALLBACK = {
  memoryMb: { critical: 2048, standard: 1024, disposable: 512 } as Record<QosTier, number>,
  deploys: 2,
  redisMb: 512,
  traefikMb: 512,
  buildkitGb: 4,
  buildkitCacheGb: 10,
};

export function memoryMiB(memoryBytes: number): number {
  return Math.floor(memoryBytes / 1024 / 1024);
}

/** Installed RAM in whole GiB from MemTotal in MiB, which reads about 4% under. install.sh does the same integer math. */
export function installedGiB(memoryMb: number): number {
  return Math.floor((Math.floor(memoryMb) * 100 + 96 * 512) / (96 * 1024));
}

/** Memory cap (MiB) for a tier, from the host's MemTotal in MiB. */
export function tierMemoryRuleMb(tier: QosTier, memoryMb: number): number {
  const { critical, standard, disposable } = TIER_MEMORY_FORMULA;
  const gib = installedGiB(memoryMb);
  const ram = gib * 1024;
  const std = clamp(roundMiB(ram / standard.divisor), standard.minMb, standard.maxMb);
  if (tier === "standard") return std;
  if (tier === "disposable") return Math.max(disposable.minMb, roundMiB(std / 2));
  const floor = gib >= critical.largeHostGiB ? critical.largeHostMinMb : critical.minMb;
  return clamp(roundMiB(ram / critical.divisor), floor, critical.maxMb);
}

/** vardo-redis's container limit in MiB, from the host's MemTotal in MiB. */
export function redisMemMb(memoryMb: number): number {
  return clamp(roundMiB((installedGiB(memoryMb) * 1024) / REDIS_FORMULA.divisor), REDIS_FORMULA.minMb, REDIS_FORMULA.maxMb);
}

/** vardo-traefik's container limit in MiB, from the host's MemTotal in MiB. install.sh mirrors it. */
export function traefikMemMb(memoryMb: number): number {
  const { divisor, minMb, maxMb } = TRAEFIK_FORMULA;
  return clamp(roundMiB((installedGiB(memoryMb) * 1024) / divisor), minMb, maxMb);
}

/** Standard leaves one core free, disposable gets half, critical is uncapped. */
export function tierCpus(tier: QosTier, cpus: number): number | null {
  if (tier === "critical") return null;
  return Math.max(1, tier === "disposable" ? Math.ceil(cpus / 2) : cpus - 1);
}

/** One deploy per two cores and per 4 GiB installed, between 1 and 6. */
export function deployConcurrency(host: HostSize): number {
  const { coresPer, gibPer, min, max } = DEPLOYS_FORMULA;
  const byRam = Math.floor(installedGiB(memoryMiB(host.memoryBytes)) / gibPer);
  return clamp(Math.min(Math.floor(host.cpus / coresPer), byRam), min, max);
}

/** Builds at once: per-build budget when no peak is recorded, buildkitd's own memory, the memory PSI that drops it to one. */
export const BUILDS_FORMULA = {
  coresPer: 4,
  budgetBytes: 3 * 1024 ** 3,
  buildkitdBytes: 640 * 1024 ** 2,
  /** Share of host memory builds may use when BuildKit has no limit. */
  unboundedShare: 0.5,
  pressureAvg10: 20,
} as const;

/** As many per-build budgets as BuildKit's memory holds and one build per four cores, at least one. */
export function buildConcurrency(input: { cpus: number; usableBytes: number; budgetBytes: number }): number {
  const byMemory = Math.floor(input.usableBytes / Math.max(1, input.budgetBytes));
  const byCores = Math.floor(input.cpus / BUILDS_FORMULA.coresPer);
  return Math.max(1, Math.min(byMemory, byCores));
}

/** Most builds at once. VARDO_MAX_CONCURRENT_BUILDS wins, floored at 1. Memory pressure makes it one. */
export function resolveBuildConcurrency(
  rule: number,
  opts: { env?: Env; memoryPressure?: boolean } = {},
): Resolved<number> {
  const parsed = parseInt((opts.env ?? process.env).VARDO_MAX_CONCURRENT_BUILDS ?? "", 10);
  const resolved: Resolved<number> = !isNaN(parsed)
    ? { value: Math.max(1, parsed), source: "override", rule }
    : { value: rule, source: "detected", rule };
  return opts.memoryPressure ? { ...resolved, value: 1 } : resolved;
}

/** A quarter of RAM, between 4 and 16 GiB. */
export function buildkitMemGb(memoryMb: number): number {
  return Math.min(16, Math.max(4, Math.floor(memoryMb / 1024 / 4)));
}

/** vardo-worker's limit in MB: a quarter of RAM in 64 MiB steps, between 768 and 1536. install.sh mirrors it. */
export function workerMemMb(memoryMb: number): number {
  return Math.min(1536, Math.max(768, Math.floor(memoryMb / 4 / 64) * 64));
}

/** BuildKit's cache ceiling in bytes: an eighth of the disk, between 5 and 60 GiB. install.sh mirrors it. */
export function buildkitCacheMaxBytes(diskBytes: number): number {
  const gib = 1024 ** 3;
  return Math.min(60, Math.max(5, Math.floor(diskBytes / gib / 8))) * gib;
}

/** vardo-redis's container limit and maxmemory, as install.sh writes them. maxmemory is 62.5% of the limit, leaving room for the AOF rewrite and snapshot forks. */
export function redisMemory(memoryMb: number): { mem: string; maxmemory: string } {
  const mb = redisMemMb(memoryMb);
  return { mem: `${mb}m`, maxmemory: `${Math.floor((mb * 5) / 8)}mb` };
}

/** Traefik's GOMEMLIMIT: 90% of its container limit, so Go's GC tightens before the OOM killer acts. install.sh mirrors it. */
export function traefikGoMemLimit(memMb: number): string {
  return `${Math.floor((memMb * 9) / 10)}MiB`;
}

/** Sizing values install.sh writes to .env, from host RAM, for the keys `current` leaves unset. */
export function hostSizedEnv(current: (key: string) => string | undefined, memoryMb: number | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (memoryMb !== null && memoryMb > 0) {
    if (!current("VARDO_TRAEFIK_MEM")) out.VARDO_TRAEFIK_MEM = `${traefikMemMb(memoryMb)}m`;
    if (!current("VARDO_WORKER_MEM")) out.VARDO_WORKER_MEM = `${workerMemMb(memoryMb)}m`;
    if (!current("VARDO_BUILDKIT_MEM")) out.VARDO_BUILDKIT_MEM = `${buildkitMemGb(memoryMb)}g`;
    if (!current("VARDO_REDIS_MEM") && !current("VARDO_REDIS_MAXMEMORY")) {
      const { mem, maxmemory } = redisMemory(memoryMb);
      out.VARDO_REDIS_MEM = mem;
      out.VARDO_REDIS_MAXMEMORY = maxmemory;
    }
  }
  const traefik = out.VARDO_TRAEFIK_MEM ?? current("VARDO_TRAEFIK_MEM");
  const traefikMb = traefik ? parseSizeMb(traefik) : null;
  if (traefikMb) {
    const limit = traefikGoMemLimit(traefikMb);
    if (!current("VARDO_TRAEFIK_GOMEMLIMIT")) out.VARDO_TRAEFIK_GOMEMLIMIT = limit;
  }
  return out;
}

/** Docker and Redis size strings (512m, 4g, 384mb) in MiB. Null when unparseable. */
export function parseSizeMb(value: string): number | null {
  const m = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "b";
  const factor = unit.startsWith("g") ? 1024 : unit.startsWith("m") ? 1 : unit.startsWith("k") ? 1 / 1024 : 1 / 1024 ** 2;
  return Math.round(n * factor);
}

type Env = Record<string, string | undefined>;

export type Resolved<T> = { value: T; source: DefaultSource; rule: T };

function resolve<T>(override: T | undefined, admin: T | undefined, host: HostSize | null, rule: T, fallback: T): Resolved<T> {
  if (override !== undefined) return { value: override, source: "override", rule };
  if (admin !== undefined) return { value: admin, source: "admin", rule };
  return host ? { value: rule, source: "detected", rule } : { value: fallback, source: "fallback", rule };
}

/** Memory cap (MB) for a tier. VARDO_DEFAULT_MEMORY_{TIER} wins when it's at least 64, then the admin value. */
export function resolveTierMemory(
  tier: QosTier,
  host: HostSize | null,
  env: Env = process.env,
  admin?: number,
): Resolved<number> {
  const raw = env[`VARDO_DEFAULT_MEMORY_${tier.toUpperCase()}`];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const rule = host ? tierMemoryRuleMb(tier, memoryMiB(host.memoryBytes)) : FALLBACK.memoryMb[tier];
  return resolve(!isNaN(parsed) && parsed >= 64 ? parsed : undefined, admin, host, rule, FALLBACK.memoryMb[tier]);
}

/** CPU cap (cores) for a tier; null means none. VARDO_DEFAULT_CPUS_{TIER} wins, 0 for none, then the admin value capped at the host's CPUs. */
export function resolveTierCpus(
  tier: QosTier,
  host: HostSize | null,
  fallbackCpus: number,
  env: Env = process.env,
  admin?: number,
): Resolved<number | null> {
  const raw = env[`VARDO_DEFAULT_CPUS_${tier.toUpperCase()}`];
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  const override = Number.isFinite(parsed) && parsed >= 0 ? (parsed > 0 ? parsed : null) : undefined;
  const rule = tierCpus(tier, host?.cpus ?? fallbackCpus);
  const adminCpus = admin !== undefined && host && host.cpus > 0 ? Math.min(admin, host.cpus) : admin;
  return resolve(override, adminCpus, host, rule, tierCpus(tier, fallbackCpus));
}

/** Most deploys at once. VARDO_MAX_DEPLOY_CONCURRENCY wins, floored at 1, then the admin value. */
export function resolveDeployConcurrency(host: HostSize | null, env: Env = process.env, admin?: number): Resolved<number> {
  const parsed = parseInt(env.VARDO_MAX_DEPLOY_CONCURRENCY ?? "", 10);
  const rule = host ? deployConcurrency(host) : FALLBACK.deploys;
  return resolve(isNaN(parsed) ? undefined : Math.max(1, parsed), admin, host, rule, FALLBACK.deploys);
}

/** A value install.sh writes to .env. Matching the rule counts as detected; unset means compose's default. */
function resolveInstallerMb(raw: string | undefined, host: HostSize | null, ruleMb: number, fallbackMb: number): Resolved<number> {
  const parsed = raw ? parseSizeMb(raw) : null;
  if (parsed === null) return { value: fallbackMb, source: "fallback", rule: ruleMb };
  return { value: parsed, source: host && parsed === ruleMb ? "detected" : "override", rule: ruleMb };
}

/** Limits read from the running containers, in MiB. Null when unreadable or unlimited. */
export type RunningLimits = {
  buildkitMemMb: number | null;
  redisMemMb: number | null;
  redisMaxmemoryMb: number | null;
  traefikMemMb: number | null;
};

const NO_RUNNING: RunningLimits = { buildkitMemMb: null, redisMemMb: null, redisMaxmemoryMb: null, traefikMemMb: null };

export type ResourceDefaultKey =
  | "memoryCritical"
  | "memoryStandard"
  | "memoryDisposable"
  | "cpusCritical"
  | "cpusStandard"
  | "cpusDisposable"
  | "deployConcurrency"
  | "buildkitMem"
  | "buildkitCache"
  | "redisMem"
  | "redisMaxmemory"
  | "traefikMem";

/** Defaults an admin can set in System settings. */
export const ADMIN_RESOURCE_KEYS = [
  "memoryCritical",
  "memoryStandard",
  "memoryDisposable",
  "cpusStandard",
  "cpusDisposable",
  "deployConcurrency",
] as const satisfies readonly ResourceDefaultKey[];

export type AdminResourceKey = (typeof ADMIN_RESOURCE_KEYS)[number];

/** Admin values by key; a missing key uses the rule. */
export type AdminResourceSettings = Partial<Record<AdminResourceKey, number>>;

export const RESOURCE_LIMITS = { memoryMinMb: 128, cpusMin: 0.25, deploysMin: 1, deploysMax: 32 };

export function isAdminResourceKey(key: string): key is AdminResourceKey {
  return (ADMIN_RESOURCE_KEYS as readonly string[]).includes(key);
}

/** Why an admin value is out of range, or null when it's fine. */
export function validateAdminValue(key: AdminResourceKey, value: number, hostCpus: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number.";
  if (key.startsWith("memory")) {
    if (!Number.isInteger(value)) return "Memory must be a whole number of MB.";
    return value < RESOURCE_LIMITS.memoryMinMb ? `Memory must be at least ${RESOURCE_LIMITS.memoryMinMb} MB.` : null;
  }
  if (key.startsWith("cpus")) {
    if (value < RESOURCE_LIMITS.cpusMin) return `CPUs must be at least ${RESOURCE_LIMITS.cpusMin}.`;
    return value > hostCpus ? `CPUs can't be more than the host's ${hostCpus}.` : null;
  }
  if (!Number.isInteger(value) || value < RESOURCE_LIMITS.deploysMin || value > RESOURCE_LIMITS.deploysMax) {
    return `Deploys at once must be a whole number from ${RESOURCE_LIMITS.deploysMin} to ${RESOURCE_LIMITS.deploysMax}.`;
  }
  return null;
}

/** Stored admin values with anything malformed dropped. CPUs aren't checked against the host here. */
export function parseAdminSettings(raw: unknown): AdminResourceSettings {
  if (!raw || typeof raw !== "object") return {};
  const out: AdminResourceSettings = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isAdminResourceKey(key) && typeof value === "number" && !validateAdminValue(key, value, Infinity)) {
      out[key] = value;
    }
  }
  return out;
}

const tierOf = (key: AdminResourceKey) => key.replace(/^(memory|cpus)/, "").toLowerCase() as QosTier;

/** The env var that sets this default when it holds a usable value, or null. */
export function envLock(key: AdminResourceKey, env: Env = process.env): string | null {
  const row =
    key === "deployConcurrency"
      ? { envVar: "VARDO_MAX_DEPLOY_CONCURRENCY", source: resolveDeployConcurrency(null, env).source }
      : key.startsWith("memory")
        ? { envVar: `VARDO_DEFAULT_MEMORY_${tierOf(key).toUpperCase()}`, source: resolveTierMemory(tierOf(key), null, env).source }
        : { envVar: `VARDO_DEFAULT_CPUS_${tierOf(key).toUpperCase()}`, source: resolveTierCpus(tierOf(key), null, 1, env).source };
  return row.source === "override" ? row.envVar : null;
}

export type ResourceDefault = {
  key: ResourceDefaultKey;
  label: string;
  envVar: string;
  unit: "mb" | "cpus" | "count";
  /** Set in .env by install.sh; takes effect when the container is recreated. */
  installer: boolean;
  /** An admin can set it in System settings. */
  editable: boolean;
  /** What the running container uses, for installer values. */
  running?: number | null;
} & Resolved<number | null>;

const TIERS: QosTier[] = ["critical", "standard", "disposable"];
const cap = (tier: QosTier) => tier[0].toUpperCase() + tier.slice(1);

/** Every sized default with its value, source and what the rule gives for this host. */
export function describeDefaults(
  host: HostSize | null,
  fallbackCpus: number,
  env: Env = process.env,
  running: RunningLimits = NO_RUNNING,
  admin: AdminResourceSettings = {},
  diskBytes: number | null = null,
): ResourceDefault[] {
  const memMb = host ? memoryMiB(host.memoryBytes) : null;
  const redisRule = memMb !== null ? redisMemMb(memMb) : FALLBACK.redisMb;
  const maxmemoryOf = (mb: number) => Math.floor((mb * 5) / 8);
  return [
    ...TIERS.map((tier) => ({
      key: `memory${cap(tier)}` as ResourceDefaultKey,
      label: `Memory cap, ${tier} tier`,
      envVar: `VARDO_DEFAULT_MEMORY_${tier.toUpperCase()}`,
      unit: "mb" as const,
      installer: false,
      editable: true,
      ...resolveTierMemory(tier, host, env, admin[`memory${cap(tier)}` as AdminResourceKey]),
    })),
    ...TIERS.map((tier) => ({
      key: `cpus${cap(tier)}` as ResourceDefaultKey,
      label: `CPU cap, ${tier} tier`,
      envVar: `VARDO_DEFAULT_CPUS_${tier.toUpperCase()}`,
      unit: "cpus" as const,
      installer: false,
      editable: tier !== "critical",
      ...resolveTierCpus(tier, host, fallbackCpus, env, tier === "critical" ? undefined : admin[`cpus${cap(tier)}` as AdminResourceKey]),
    })),
    {
      key: "deployConcurrency",
      label: "Deploys at once",
      envVar: "VARDO_MAX_DEPLOY_CONCURRENCY",
      unit: "count",
      installer: false,
      editable: true,
      ...resolveDeployConcurrency(host, env, admin.deployConcurrency),
    },
    {
      key: "buildkitMem",
      label: "BuildKit memory",
      envVar: "VARDO_BUILDKIT_MEM",
      unit: "mb",
      installer: true,
      editable: false,
      running: running.buildkitMemMb,
      ...resolveInstallerMb(
        env.VARDO_BUILDKIT_MEM,
        host,
        (memMb !== null ? buildkitMemGb(memMb) : FALLBACK.buildkitGb) * 1024,
        FALLBACK.buildkitGb * 1024,
      ),
    },
    {
      key: "buildkitCache",
      label: "BuildKit cache ceiling",
      envVar: "VARDO_BUILDKIT_CACHE_MAX",
      unit: "mb",
      installer: true,
      editable: false,
      ...resolveInstallerMb(
        env.VARDO_BUILDKIT_CACHE_MAX,
        diskBytes !== null ? host : null,
        Math.floor((diskBytes !== null ? buildkitCacheMaxBytes(diskBytes) : FALLBACK.buildkitCacheGb * 1024 ** 3) / 1024 ** 2),
        FALLBACK.buildkitCacheGb * 1024,
      ),
    },
    {
      key: "redisMem",
      label: "Redis memory",
      envVar: "VARDO_REDIS_MEM",
      unit: "mb",
      installer: true,
      editable: false,
      running: running.redisMemMb,
      ...resolveInstallerMb(env.VARDO_REDIS_MEM, host, redisRule, FALLBACK.redisMb),
    },
    {
      key: "redisMaxmemory",
      label: "Redis maxmemory",
      envVar: "VARDO_REDIS_MAXMEMORY",
      unit: "mb",
      installer: true,
      editable: false,
      running: running.redisMaxmemoryMb,
      ...resolveInstallerMb(
        env.VARDO_REDIS_MAXMEMORY,
        host,
        maxmemoryOf(redisRule),
        maxmemoryOf(FALLBACK.redisMb),
      ),
    },
    {
      key: "traefikMem",
      label: "Traefik memory",
      envVar: "VARDO_TRAEFIK_MEM",
      unit: "mb",
      installer: true,
      editable: false,
      running: running.traefikMemMb,
      ...resolveInstallerMb(env.VARDO_TRAEFIK_MEM, host, memMb !== null ? traefikMemMb(memMb) : FALLBACK.traefikMb, FALLBACK.traefikMb),
    },
  ];
}
