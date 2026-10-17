// Deploy metadata Vardo sets in every rotating service's environment, and the subset builds get.

export const DEPLOY_VAR_KEYS = [
  "VARDO_GIT_SHA",
  "VARDO_GIT_BRANCH",
  "VARDO_DEPLOY_ID",
  "VARDO_DEPLOYED_AT",
  "VARDO_APP_NAME",
  "VARDO_APP_URL",
  "VARDO_ENVIRONMENT",
  "VARDO_MEMORY_LIMIT",
  "VARDO_SLOT",
] as const;

export type DeployVarKey = (typeof DEPLOY_VAR_KEYS)[number];

/** The only deploy variables a build sees; the rest change every deploy and would bust the cache. */
export const BUILD_VAR_KEYS = ["VARDO_GIT_SHA", "VARDO_GIT_BRANCH"] as const;

const SHA_RE = /^[0-9a-f]{40}$/i;

export type DeployMeta = {
  gitSha?: string | null;
  gitBranch?: string | null;
  deploymentId: string;
  deployedAt: Date;
  environment: string;
  /** blue or green; null for a local environment. */
  slot?: string | null;
};

export type ServiceIdentity = {
  appName: string;
  url: string | null;
  memoryBytes: number | null;
};

/** Commit and branch for a build, minus any the app's env sets itself. */
export function buildVars(
  gitSha: string | null | undefined,
  gitBranch: string | null | undefined,
  appEnv: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!gitSha || !SHA_RE.test(gitSha)) return out;
  out.VARDO_GIT_SHA = gitSha.toLowerCase();
  if (gitBranch) out.VARDO_GIT_BRANCH = gitBranch;
  for (const k of Object.keys(out)) if (k in appEnv) delete out[k];
  return out;
}

/** A service's deploy variables. Keys without a value are left out. */
export function deployVars(meta: DeployMeta, svc: ServiceIdentity): Record<string, string> {
  const out: Record<string, string> = {
    ...buildVars(meta.gitSha, meta.gitBranch),
    VARDO_DEPLOY_ID: meta.deploymentId,
    VARDO_DEPLOYED_AT: meta.deployedAt.toISOString(),
    VARDO_APP_NAME: svc.appName,
    VARDO_ENVIRONMENT: meta.environment,
  };
  if (svc.url) out.VARDO_APP_URL = svc.url;
  if (svc.memoryBytes) out.VARDO_MEMORY_LIMIT = String(svc.memoryBytes);
  if (meta.slot === "blue" || meta.slot === "green") out.VARDO_SLOT = meta.slot;
  return out;
}

/** `vars` without the keys the app or service sets itself. */
export function withoutOwn(vars: Record<string, string>, ...own: (Record<string, unknown> | undefined)[]): Record<string, string> {
  const out = { ...vars };
  for (const env of own) for (const k of Object.keys(env ?? {})) delete out[k];
  return out;
}

/** A compose memory size (512M, 1g, 1073741824) in bytes. Null when unset or unparseable. */
export function memoryBytes(limit: string | number | null | undefined): number | null {
  if (typeof limit === "number") return limit > 0 ? Math.round(limit) : null;
  const m = limit?.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/);
  if (!m) return null;
  const unit = (m[2] ?? "b")[0];
  const factor = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
  const bytes = Math.round(Number(m[1]) * factor);
  return bytes > 0 ? bytes : null;
}

type UrlDomain = {
  /** Unset means the app itself. */
  appId?: string;
  domain: string;
  pathPrefix?: string | null;
  serviceName?: string | null;
  isPrimary?: boolean | null;
  enabled?: boolean | null;
  sslEnabled?: boolean | null;
  redirectTo?: string | null;
};

/** The URL a domain row serves. */
export function domainUrl(d: UrlDomain): string {
  const path = d.pathPrefix ? `/${d.pathPrefix.replace(/^\/+|\/+$/g, "")}` : "";
  return `${d.sslEnabled === false ? "http" : "https"}://${d.domain}${path}`;
}

function primaryOf(domains: UrlDomain[]): UrlDomain | undefined {
  const serving = domains.filter((d) => !d.redirectTo && d.enabled !== false);
  return serving.find((d) => d.isPrimary) ?? serving[0];
}

/** Each service's URL: its own child app's primary domain, else the app's. */
export function serviceUrls(
  domains: UrlDomain[],
  appId: string,
  services: string[],
  childServices: ReadonlySet<string>,
): Record<string, string | null> {
  const isOwn = (d: UrlDomain) => d.appId === undefined || d.appId === appId;
  const own = domains.filter(isOwn);
  const app = primaryOf(own) ?? primaryOf(domains);
  const out: Record<string, string | null> = {};
  for (const service of services) {
    const mine = childServices.has(service)
      ? primaryOf(domains.filter((d) => !isOwn(d) && d.serviceName === service))
      : undefined;
    const d = mine ?? app;
    out[service] = d ? domainUrl(d) : null;
  }
  return out;
}
