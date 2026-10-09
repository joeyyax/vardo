// Sizing defaults from the host's CPU count and memory. install.sh mirrors the Redis and BuildKit rules.

export type QosTier = "critical" | "standard" | "disposable";

/** What Docker's /info reports. */
export type HostSize = { cpus: number; memoryBytes: number };

/** Detected: the rule applied to the host. Override: an env var set it. Admin: set in System settings. Fallback: the host couldn't be read. */
export type DefaultSource = "detected" | "override" | "admin" | "fallback";

export type SizeClass = {
  name: "small" | "medium" | "large" | "xlarge";
  /** The class covers hosts with less memory than this, in GiB. */
  belowGiB: number;
  /** Memory cap (MB) per tier when an app sets none. */
  memoryMb: Record<QosTier, number>;
  /** Most deploys at once, before the CPU cap. */
  deploys: number;
  /** vardo-redis container limit (MB). */
  redisMb: number;
};

/** Host memory decides the class. The boundaries sit below round sizes because MemTotal reads under the installed RAM. */
export const SIZE_CLASSES: readonly SizeClass[] = [
  { name: "small", belowGiB: 6, memoryMb: { critical: 1024, standard: 1024, disposable: 512 }, deploys: 1, redisMb: 512 },
  { name: "medium", belowGiB: 24, memoryMb: { critical: 2048, standard: 1024, disposable: 512 }, deploys: 2, redisMb: 512 },
  { name: "large", belowGiB: 96, memoryMb: { critical: 4096, standard: 2048, disposable: 1024 }, deploys: 4, redisMb: 1024 },
  { name: "xlarge", belowGiB: Infinity, memoryMb: { critical: 8192, standard: 4096, disposable: 2048 }, deploys: 6, redisMb: 2048 },
];

/** The values used when the host can't be read: Vardo's fixed defaults before sizing. */
export const FALLBACK = {
  memoryMb: { critical: 2048, standard: 1024, disposable: 512 } as Record<QosTier, number>,
  deploys: 2,
  redisMb: 512,
  buildkitGb: 4,
  buildkitCacheGb: 10,
};

export function memoryMiB(memoryBytes: number): number {
  return Math.floor(memoryBytes / 1024 / 1024);
}

export function sizeClass(memoryMb: number): SizeClass {
  return SIZE_CLASSES.find((c) => memoryMb < c.belowGiB * 1024) ?? SIZE_CLASSES[SIZE_CLASSES.length - 1];
}

/** Standard leaves one core free, disposable gets half, critical is uncapped. */
export function tierCpus(tier: QosTier, cpus: number): number | null {
  if (tier === "critical") return null;
  return Math.max(1, tier === "disposable" ? Math.ceil(cpus / 2) : cpus - 1);
}

/** The class's deploy count, capped at one per two cores. */
export function deployConcurrency(host: HostSize): number {
  return Math.max(1, Math.min(sizeClass(memoryMiB(host.memoryBytes)).deploys, Math.floor(host.cpus / 2)));
}

/** A quarter of RAM, between 2 and 16 GiB. */
export function buildkitMemGb(memoryMb: number): number {
  return Math.min(16, Math.max(2, Math.floor(memoryMb / 1024 / 4)));
}

/** BuildKit's cache ceiling in bytes: a tenth of the disk, between 5 and 50 GiB. install.sh mirrors it. */
export function buildkitCacheMaxBytes(diskBytes: number): number {
  const gib = 1024 ** 3;
  return Math.min(50, Math.max(5, Math.floor(diskBytes / gib / 10))) * gib;
}

/** vardo-redis's container limit and maxmemory, as install.sh writes them. maxmemory is 75% of the limit. */
export function redisMemory(memoryMb: number): { mem: string; maxmemory: string } {
  const mb = sizeClass(memoryMb).redisMb;
  return { mem: `${mb}m`, maxmemory: `${Math.floor((mb * 3) / 4)}mb` };
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
  const rule = host ? sizeClass(memoryMiB(host.memoryBytes)).memoryMb[tier] : FALLBACK.memoryMb[tier];
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
export type RunningLimits = { buildkitMemMb: number | null; redisMemMb: number | null; redisMaxmemoryMb: number | null };

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
  | "redisMaxmemory";

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
  running: RunningLimits = { buildkitMemMb: null, redisMemMb: null, redisMaxmemoryMb: null },
  admin: AdminResourceSettings = {},
  diskBytes: number | null = null,
): ResourceDefault[] {
  const memMb = host ? memoryMiB(host.memoryBytes) : null;
  const redisRule = memMb !== null ? sizeClass(memMb).redisMb : FALLBACK.redisMb;
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
        Math.floor((redisRule * 3) / 4),
        Math.floor((FALLBACK.redisMb * 3) / 4),
      ),
    },
  ];
}
