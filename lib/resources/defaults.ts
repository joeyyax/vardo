// Sizing defaults from the host's CPU count and memory. install.sh mirrors the Redis and BuildKit rules.

export type QosTier = "critical" | "standard" | "disposable";

/** What Docker's /info reports. */
export type HostSize = { cpus: number; memoryBytes: number };

/** Detected: the rule applied to the host. Override: an env var set it. Fallback: the host couldn't be read. */
export type DefaultSource = "detected" | "override" | "fallback";

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

function resolve<T>(override: T | undefined, host: HostSize | null, rule: T, fallback: T): Resolved<T> {
  if (override !== undefined) return { value: override, source: "override", rule };
  return host ? { value: rule, source: "detected", rule } : { value: fallback, source: "fallback", rule };
}

/** Memory cap (MB) for a tier. VARDO_DEFAULT_MEMORY_{TIER} wins when it's at least 64. */
export function resolveTierMemory(tier: QosTier, host: HostSize | null, env: Env = process.env): Resolved<number> {
  const raw = env[`VARDO_DEFAULT_MEMORY_${tier.toUpperCase()}`];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const rule = host ? sizeClass(memoryMiB(host.memoryBytes)).memoryMb[tier] : FALLBACK.memoryMb[tier];
  return resolve(!isNaN(parsed) && parsed >= 64 ? parsed : undefined, host, rule, FALLBACK.memoryMb[tier]);
}

/** CPU cap (cores) for a tier; null means none. VARDO_DEFAULT_CPUS_{TIER} wins, 0 for none. */
export function resolveTierCpus(
  tier: QosTier,
  host: HostSize | null,
  fallbackCpus: number,
  env: Env = process.env,
): Resolved<number | null> {
  const raw = env[`VARDO_DEFAULT_CPUS_${tier.toUpperCase()}`];
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  const override = Number.isFinite(parsed) && parsed >= 0 ? (parsed > 0 ? parsed : null) : undefined;
  const rule = tierCpus(tier, host?.cpus ?? fallbackCpus);
  return resolve(override, host, rule, tierCpus(tier, fallbackCpus));
}

/** Most deploys at once. VARDO_MAX_DEPLOY_CONCURRENCY wins, floored at 1. */
export function resolveDeployConcurrency(host: HostSize | null, env: Env = process.env): Resolved<number> {
  const parsed = parseInt(env.VARDO_MAX_DEPLOY_CONCURRENCY ?? "", 10);
  const rule = host ? deployConcurrency(host) : FALLBACK.deploys;
  return resolve(isNaN(parsed) ? undefined : Math.max(1, parsed), host, rule, FALLBACK.deploys);
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
  | "redisMem"
  | "redisMaxmemory";

export type ResourceDefault = {
  key: ResourceDefaultKey;
  label: string;
  envVar: string;
  unit: "mb" | "cpus" | "count";
  /** Set in .env by install.sh; takes effect when the container is recreated. */
  installer: boolean;
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
      ...resolveTierMemory(tier, host, env),
    })),
    ...TIERS.map((tier) => ({
      key: `cpus${cap(tier)}` as ResourceDefaultKey,
      label: `CPU cap, ${tier} tier`,
      envVar: `VARDO_DEFAULT_CPUS_${tier.toUpperCase()}`,
      unit: "cpus" as const,
      installer: false,
      ...resolveTierCpus(tier, host, fallbackCpus, env),
    })),
    {
      key: "deployConcurrency",
      label: "Deploys at once",
      envVar: "VARDO_MAX_DEPLOY_CONCURRENCY",
      unit: "count",
      installer: false,
      ...resolveDeployConcurrency(host, env),
    },
    {
      key: "buildkitMem",
      label: "BuildKit memory",
      envVar: "VARDO_BUILDKIT_MEM",
      unit: "mb",
      installer: true,
      running: running.buildkitMemMb,
      ...resolveInstallerMb(
        env.VARDO_BUILDKIT_MEM,
        host,
        (memMb !== null ? buildkitMemGb(memMb) : FALLBACK.buildkitGb) * 1024,
        FALLBACK.buildkitGb * 1024,
      ),
    },
    {
      key: "redisMem",
      label: "Redis memory",
      envVar: "VARDO_REDIS_MEM",
      unit: "mb",
      installer: true,
      running: running.redisMemMb,
      ...resolveInstallerMb(env.VARDO_REDIS_MEM, host, redisRule, FALLBACK.redisMb),
    },
    {
      key: "redisMaxmemory",
      label: "Redis maxmemory",
      envVar: "VARDO_REDIS_MAXMEMORY",
      unit: "mb",
      installer: true,
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
