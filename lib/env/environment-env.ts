// Non-default environments read environment_env, snapshotted from the app's env at creation.

import { randomBytes } from "node:crypto";
import { encrypt, decryptOrFallback } from "@/lib/crypto/encrypt";
import { isSecretKey } from "./is-secret-key";
import { parseEnvToMap } from "./parse-env";
import { scanEnv } from "./dotenv";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace whole hostnames only, longest first, so `api.x.me` never rewrites inside `myapi.x.me`. */
export function rewriteHosts(content: string, replacements: Map<string, string>): string {
  const hosts = [...replacements.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (hosts.length === 0) return content;
  const pattern = new RegExp(
    `(?<![A-Za-z0-9.-])(${hosts.map(escapeRegExp).join("|")})(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`,
    "g",
  );
  return content.replace(pattern, (host) => replacements.get(host) ?? host);
}

/** A random secret, URL-safe so it drops into a connection string as is. */
export function generateSecret(): string {
  return randomBytes(24).toString("base64url");
}

/** Replaces every secret-looking value; `generated` keeps a shared value's replacement consistent. */
export function regenerateSecrets(
  content: string,
  generated: Map<string, string>,
): { content: string; regenerated: string[] } {
  const regenerated: string[] = [];
  const lines = scanEnv(content, "loose").map((segment) => {
    if (segment.kind === "text") return segment.raw;
    const { raw, key } = segment;
    const eq = raw.indexOf("=");
    const value = segment.multiline
      ? segment.value
      : raw.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    // An empty value or a ${ref} has no production secret to replace.
    if (!isSecretKey(key) || !value || value.includes("${")) return raw;
    let next = generated.get(value);
    if (!next) {
      next = generateSecret();
      generated.set(value, next);
    }
    regenerated.push(key);
    return `${raw.slice(0, eq)}=${next}`;
  });
  return { content: lines.join("\n"), regenerated };
}

export type EnvSnapshot = {
  /** Encrypted under the org's key, ready for environment_env.env_content. */
  envContent: string;
  varCount: number;
  regenerated: string[];
};

/** Snapshots an app's env for a new environment, rewriting hostnames and, for `empty`, generating secrets. */
export function snapshotEnv(opts: {
  appEnvContent: string | null;
  organizationId: string;
  hostReplacements?: Map<string, string>;
  strategy?: string | null;
  /** Shared across one group environment's snapshots. */
  generatedSecrets?: Map<string, string>;
}): EnvSnapshot {
  let content = "";
  if (opts.appEnvContent) {
    const { content: plain, decryptFailed } = decryptOrFallback(opts.appEnvContent, opts.organizationId);
    if (decryptFailed) {
      throw new Error("Could not decrypt the app's environment variables — check ENCRYPTION_MASTER_KEY");
    }
    content = plain;
  }
  content = rewriteHosts(content, opts.hostReplacements ?? new Map());
  let regenerated: string[] = [];
  if (opts.strategy === "empty") {
    ({ content, regenerated } = regenerateSecrets(content, opts.generatedSecrets ?? new Map()));
  }
  return {
    envContent: encrypt(content, opts.organizationId),
    varCount: Object.keys(parseEnvToMap(content)).length,
    regenerated,
  };
}

/** Literal production hostnames an environment's env still points at, as `KEY → host` pairs. */
export function productionHostRefs(
  env: Record<string, string>,
  productionHosts: string[],
): { key: string; host: string }[] {
  const found: { key: string; host: string }[] = [];
  for (const host of productionHosts) {
    if (!host) continue;
    const pattern = new RegExp(`(?<![A-Za-z0-9.-])${escapeRegExp(host)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`);
    for (const [key, value] of Object.entries(env)) {
      if (pattern.test(value)) found.push({ key, host });
    }
  }
  return found;
}
