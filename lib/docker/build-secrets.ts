// BuildKit secrets a build mounts with `RUN --mount=type=secret,id=<id>`. They reach the docker CLI through its env only.

import { stringify } from "yaml";

/** The deploy's GitHub token, for private packages on npm.pkg.github.com. */
export const NPM_TOKEN_SECRET = "npm_token";

/** Secret id to value. */
export type BuildSecrets = Record<string, string>;

/** Safe in a `--secret` spec, a compose key and an env var name. */
export const BUILD_SECRET_ID = /^[a-z][a-z0-9_]*$/;

export type BuildSecretSource = "organization" | "github-app";

/** The deploy's secrets and where each came from. An org secret beats the GitHub App token of the same id. */
export function resolveBuildSecrets(
  githubToken: string | null | undefined,
  org: BuildSecrets,
): { secrets: BuildSecrets; sources: Record<string, BuildSecretSource> } {
  const secrets: BuildSecrets = {};
  const sources: Record<string, BuildSecretSource> = {};
  if (githubToken) {
    secrets[NPM_TOKEN_SECRET] = githubToken;
    sources[NPM_TOKEN_SECRET] = "github-app";
  }
  for (const [id, value] of usable(org)) {
    secrets[id] = value;
    sources[id] = "organization";
  }
  return { secrets, sources };
}

/** Env var the docker CLI reads a secret from. */
export function secretEnvName(id: string): string {
  return `VARDO_BUILD_SECRET_${id.toUpperCase()}`;
}

function usable(secrets?: BuildSecrets | null): [string, string][] {
  return Object.entries(secrets ?? {})
    .filter(([id, value]) => BUILD_SECRET_ID.test(id) && Boolean(value))
    .sort(([a], [b]) => a.localeCompare(b));
}

export function buildSecretIds(secrets?: BuildSecrets | null): string[] {
  return usable(secrets).map(([id]) => id);
}

/** The values, keyed by the env var each secret's spec names. */
export function buildSecretEnv(secrets?: BuildSecrets | null): Record<string, string> {
  return Object.fromEntries(usable(secrets).map(([id, value]) => [secretEnvName(id), value]));
}

/** `id=<id>,env=<var>` specs; they name each value's env var, never the value. */
export function buildSecretSpecs(secrets?: BuildSecrets | null): string[] {
  return buildSecretIds(secrets).map((id) => `id=${id},env=${secretEnvName(id)}`);
}

/** `--secret` flags for `docker build`. */
export function buildSecretArgs(secrets?: BuildSecrets | null): string[] {
  return buildSecretSpecs(secrets).flatMap((spec) => ["--secret", spec]);
}

/** Secrets the compose file doesn't define itself; its own definition wins. */
export function undeclaredSecrets(secrets: BuildSecrets | null | undefined, declared?: Record<string, unknown> | null): BuildSecrets {
  return Object.fromEntries(usable(secrets).filter(([id]) => !(declared && id in declared)));
}

/** A bake definition with the secrets on every target. */
export function withBakeSecrets(bake: string, secrets?: BuildSecrets | null): string {
  const specs = buildSecretSpecs(secrets);
  if (specs.length === 0) return bake;
  const parsed = JSON.parse(bake) as { target?: Record<string, { secret?: unknown[] }> };
  for (const target of Object.values(parsed.target ?? {})) {
    target.secret = [...(Array.isArray(target.secret) ? target.secret : []), ...specs];
  }
  return JSON.stringify(parsed, null, 2);
}

/** A compose file granting the secrets to these services' builds, or null when there are none. */
export function composeSecretsYaml(services: string[], secrets?: BuildSecrets | null): string | null {
  const ids = buildSecretIds(secrets);
  if (ids.length === 0 || services.length === 0) return null;
  return stringify({
    services: Object.fromEntries(services.map((name) => [name, { build: { secrets: [...ids] } }])),
    secrets: Object.fromEntries(ids.map((id) => [id, { environment: secretEnvName(id) }])),
  });
}
